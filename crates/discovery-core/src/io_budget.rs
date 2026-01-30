//! I/O budget tracking for discovery operations.
//!
//! This module provides a thread-safe budget counter to limit storage I/O
//! operations during discovery. Each storage operation has an associated cost,
//! and discovery functions consume from the budget before performing I/O.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// Thread-safe I/O budget counter.
///
/// Used to limit the number of storage operations during discovery.
/// Operations atomically consume from the budget before performing I/O.
///
/// `IoBudget` is cheap to clone - clones share the same underlying counter,
/// making it easy to pass across async tasks.
#[derive(Debug, Clone)]
pub struct IoBudget {
    remaining: Arc<AtomicUsize>,
}

impl IoBudget {
    /// Creates a new budget with the given limit.
    pub fn new(limit: usize) -> Self {
        Self {
            remaining: Arc::new(AtomicUsize::new(limit)),
        }
    }

    /// Returns the current remaining budget.
    pub fn remaining(&self) -> usize {
        self.remaining.load(Ordering::Relaxed)
    }

    /// Atomically consumes `count` from the budget.
    ///
    /// Returns `true` on success, `false` if insufficient budget.
    /// On `false`, the budget remains unchanged.
    pub fn consume(&self, count: usize) -> bool {
        self.remaining
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |current| {
                current.checked_sub(count)
            })
            .is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn test_consume_success() {
        let budget = IoBudget::new(10);

        assert_eq!(budget.remaining(), 10);

        assert!(budget.consume(3));
        assert_eq!(budget.remaining(), 7);

        assert!(budget.consume(5));
        assert_eq!(budget.remaining(), 2);

        assert!(budget.consume(2));
        assert_eq!(budget.remaining(), 0);
    }

    #[test]
    fn test_consume_exhausted() {
        let budget = IoBudget::new(5);

        // Try to consume more than available
        assert!(!budget.consume(10));
        assert_eq!(budget.remaining(), 5); // Unchanged

        // Partial consumption then exhaustion
        assert!(budget.consume(3));
        assert_eq!(budget.remaining(), 2);

        assert!(!budget.consume(3));
        assert_eq!(budget.remaining(), 2); // Unchanged

        // Exact remaining works
        assert!(budget.consume(2));
        assert_eq!(budget.remaining(), 0);

        // Zero budget, any consumption fails
        assert!(!budget.consume(1));
        assert_eq!(budget.remaining(), 0);
    }

    #[test]
    fn test_concurrent_consume() {
        let budget = IoBudget::new(1000);
        let mut handles = vec![];

        // Spawn 10 threads, each consuming 1 unit 100 times
        for _ in 0..10 {
            let budget = budget.clone(); // Cheap clone, shares the counter
            handles.push(thread::spawn(move || {
                let mut successes = 0;
                for _ in 0..100 {
                    if budget.consume(1) {
                        successes += 1;
                    }
                }
                successes
            }));
        }

        let total_successes: usize = handles.into_iter().map(|h| h.join().unwrap()).sum();

        // All 1000 units should have been consumed exactly
        assert_eq!(total_successes, 1000);
        assert_eq!(budget.remaining(), 0);
    }
}
