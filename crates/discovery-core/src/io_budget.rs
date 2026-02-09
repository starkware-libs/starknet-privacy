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

    /// Atomically consumes as many whole items as the budget allows.
    ///
    /// Returns `(num_consumed_items, budget_exhausted)`:
    /// - `num_consumed_items`: number of items consumed (0..=`max_items`).
    /// - `budget_exhausted`: `true` when the budget limited how many items could
    ///   be consumed (i.e. `consumed < max_items`).
    ///   Callers use this to derive `has_more` for pagination cursors.
    ///
    /// When `max_items == 0`, returns `(0, false)` — the request is trivially
    /// satisfied, not budget-limited.
    ///
    /// # Panics
    ///
    /// Panics if `cost_per_item == 0`. All callers use compile-time cost constants;
    /// a zero cost is always a programmer bug.
    pub fn consume_up_to(&self, max_items: usize, cost_per_item: usize) -> (usize, bool) {
        assert!(
            cost_per_item > 0,
            "cost_per_item must be positive; zero-cost items are not supported"
        );
        if max_items == 0 {
            return (0, false);
        }
        let num_consumed_items = self
            .remaining
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |current| {
                let num_items = (current / cost_per_item).min(max_items);
                current.checked_sub(num_items * cost_per_item)
            })
            .map(|old| (old / cost_per_item).min(max_items))
            .unwrap_or(0);
        let budget_exhausted = num_consumed_items < max_items;
        (num_consumed_items, budget_exhausted)
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
    fn test_consume_up_to_exact_budget() {
        let budget = IoBudget::new(9);
        // 9 / 3 = 3 items, but max is 2 → not budget-limited (got what we asked for)
        assert_eq!(budget.consume_up_to(2, 3), (2, false));
        assert_eq!(budget.remaining(), 3);
        // 3 / 3 = 1 item, asked for 5 → budget-limited
        assert_eq!(budget.consume_up_to(5, 3), (1, true));
        assert_eq!(budget.remaining(), 0);
    }

    #[test]
    fn test_consume_up_to_partial_budget() {
        let budget = IoBudget::new(7);
        // 7 / 3 = 2 items, asked for 10 → budget-limited
        assert_eq!(budget.consume_up_to(10, 3), (2, true));
        assert_eq!(budget.remaining(), 1);
        // 1 / 3 = 0 items → budget-limited
        assert_eq!(budget.consume_up_to(10, 3), (0, true));
        assert_eq!(budget.remaining(), 1); // unchanged
    }

    #[test]
    fn test_consume_up_to_zero_budget() {
        let budget = IoBudget::new(0);
        // Asked for 5 but budget is 0 → budget-limited
        assert_eq!(budget.consume_up_to(5, 3), (0, true));
        assert_eq!(budget.remaining(), 0);
    }

    #[test]
    #[should_panic(expected = "cost_per_item must be positive")]
    fn test_consume_up_to_zero_cost_panics() {
        let budget = IoBudget::new(10);
        budget.consume_up_to(5, 0);
    }

    #[test]
    fn test_consume_up_to_zero_max_items() {
        let budget = IoBudget::new(10);
        // Asked for 0 → trivially satisfied, not budget-limited
        assert_eq!(budget.consume_up_to(0, 3), (0, false));
        assert_eq!(budget.remaining(), 10); // unchanged
    }

    #[test]
    fn test_consume_up_to_concurrent() {
        let budget = IoBudget::new(100);
        let mut handles = vec![];

        // 10 threads each trying to consume up to 5 items at cost 2 = 10 per thread
        for _ in 0..10 {
            let budget = budget.clone();
            handles.push(thread::spawn(move || budget.consume_up_to(5, 2).0));
        }

        let total: usize = handles.into_iter().map(|h| h.join().unwrap()).sum();

        // 100 / 2 = 50 items total possible
        assert_eq!(total, 50);
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
