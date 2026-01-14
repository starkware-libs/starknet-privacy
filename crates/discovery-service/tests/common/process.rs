//! Shared process utilities for integration tests.

use std::io::BufRead;
use std::net::TcpListener;
use std::time::{Duration, Instant};

use anyhow::{bail, Result};
use nix::sys::signal::{kill, Signal};
use nix::unistd::Pid;

/// Wait for any of the given patterns in log output (sync/blocking).
pub fn wait_for_log_pattern(
    reader: impl BufRead,
    patterns: &[&str],
    timeout: Duration,
) -> Result<String> {
    let start = Instant::now();
    for line in reader.lines().map_while(Result::ok) {
        if start.elapsed() > timeout {
            bail!("Timeout waiting for log pattern");
        }
        if patterns.iter().any(|&p| line.contains(p)) {
            return Ok(line);
        }
    }
    bail!("Log stream ended without matching pattern")
}

/// Send a signal to a process.
pub fn signal_process(pid: u32, signal: Signal) -> Result<()> {
    kill(Pid::from_raw(pid as i32), signal)?;
    Ok(())
}

/// Find an available port.
pub fn find_free_port() -> Result<u16> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}
