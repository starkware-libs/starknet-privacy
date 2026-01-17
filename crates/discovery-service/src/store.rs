//! Storage layer with multi-reader, single-writer SQLite backend.

use serde::Serialize;
use sqlx::pool::PoolConnection;
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous,
    SqliteTransactionManager,
};
use sqlx::{Pool, Row, Sqlite, TransactionManager};
use starknet::core::types::Felt;
use std::ops::DerefMut;
use std::path::Path;
use thiserror::Error;
use tokio::fs;

const SQLITE_BUSY_TIMEOUT_MS: u64 = 5000;
const SQLITE_MAX_READERS: u32 = 10;

/// Errors that can occur during storage operations.
#[derive(Debug, Error)]
pub enum StoreError {
    /// Failed to create directory for database.
    #[error("Failed to create directory: {0}")]
    CreateDir(#[from] std::io::Error),
    /// SQLx database error.
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    /// Transaction error.
    #[error("Transaction error: {0}")]
    Transaction(String),
}

/// Current indexed head information.
#[derive(Debug, Clone, Serialize)]
pub struct Head {
    pub block_number: u64,
    pub block_hash: String,
    pub timestamp: u64,
}

/// Current indexed state for state diffs (separate from chain head).
#[derive(Debug, Clone)]
pub struct IndexedState {
    pub block_height: u64,
    pub block_hash: Felt,
}

/// Storage operations for the discovery service.
#[async_trait::async_trait]
pub trait Store: Send + Sync {
    /// Store a block.
    async fn store_block(&mut self, height: u64, hash: Felt) -> Result<(), StoreError>;

    /// Update the head with height, hash, and timestamp (Unix seconds).
    async fn set_head(&mut self, height: u64, hash: Felt, timestamp: u64)
        -> Result<(), StoreError>;

    /// Get current head information.
    /// Returns None if no head has been set yet.
    async fn get_head(&mut self) -> Result<Option<Head>, StoreError>;

    /// Get the current indexed state (separate from chain head).
    /// Returns None if no state has been indexed yet.
    async fn get_indexed_state(&mut self) -> Result<Option<IndexedState>, StoreError>;

    /// Set the indexed state height and hash.
    async fn set_indexed_state(&mut self, height: u64, hash: Felt) -> Result<(), StoreError>;

    /// Batch insert storage diffs for a block.
    /// Each entry is (key, value).
    async fn batch_insert_storage_diffs(
        &mut self,
        height: u64,
        entries: &[(Felt, Felt)],
    ) -> Result<(), StoreError>;

    /// Commit changes.
    async fn commit(&mut self) -> Result<(), StoreError>;
}

/// SQLite-backed storage with multi-reader, single-writer pattern.
#[derive(Debug)]
pub struct SqliteStore {
    pool: Pool<Sqlite>,
}

impl SqliteStore {
    /// Create a writer instance (single connection for atomic writes).
    pub async fn writer<P: AsRef<Path>>(path: P) -> Result<Self, StoreError> {
        if let Some(parent) = path.as_ref().parent() {
            fs::create_dir_all(parent).await?;
        }

        let options = SqliteConnectOptions::new()
            .filename(path.as_ref())
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .busy_timeout(std::time::Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS));

        let pool = SqlitePoolOptions::new()
            .max_connections(1) // Single writer
            .connect_with(options)
            .await?;

        let store = Self { pool };
        store.init().await?;
        Ok(store)
    }

    /// Create a reader instance (multiple concurrent connections, lazy connect).
    pub fn reader<P: AsRef<Path>>(path: P) -> Self {
        let options = SqliteConnectOptions::new()
            .filename(path.as_ref())
            .read_only(true);

        let pool = SqlitePoolOptions::new()
            .max_connections(SQLITE_MAX_READERS)
            .connect_lazy_with(options);

        Self { pool }
    }

    /// Acquire a connection from the pool.
    pub async fn acquire(&self) -> Result<PoolConnection<Sqlite>, StoreError> {
        self.pool.acquire().await.map_err(StoreError::from)
    }

    /// Initialize database schema.
    async fn init(&self) -> Result<(), StoreError> {
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            "#,
        )
        .execute(&self.pool)
        .await?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS blocks (
                height INTEGER NOT NULL,
                hash TEXT PRIMARY KEY
            );
            "#,
        )
        .execute(&self.pool)
        .await?;

        // Index for fast delete by height (reorg handling)
        sqlx::query(r#"CREATE INDEX IF NOT EXISTS idx_blocks_height ON blocks (height);"#)
            .execute(&self.pool)
            .await?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS storage_diffs (
                block_height INTEGER NOT NULL,
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            "#,
        )
        .execute(&self.pool)
        .await?;

        sqlx::query(
            r#"CREATE INDEX IF NOT EXISTS idx_storage_diffs_block_height ON storage_diffs (block_height);"#,
        )
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    /// Begin a new transaction.
    /// NOTE that this function does not check if there is already a transaction in progress.
    pub async fn begin(&self) -> Result<PoolConnection<Sqlite>, StoreError> {
        let mut conn = self.pool.acquire().await?;
        SqliteTransactionManager::begin(&mut conn, None)
            .await
            .map_err(|e| StoreError::Transaction(e.to_string()))?;
        Ok(conn)
    }
}

#[async_trait::async_trait]
impl Store for PoolConnection<Sqlite> {
    async fn store_block(&mut self, height: u64, hash: Felt) -> Result<(), StoreError> {
        sqlx::query("INSERT INTO blocks (height, hash) VALUES (?, ?)")
            .bind(height as i64)
            .bind(format!("{:#066x}", hash))
            .execute(self.deref_mut())
            .await?;
        Ok(())
    }

    async fn set_head(
        &mut self,
        height: u64,
        hash: Felt,
        timestamp: u64,
    ) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT OR REPLACE INTO meta (key, value) \
            VALUES ('head_height', ?), ('head_hash', ?), ('head_timestamp', ?)",
        )
        .bind(height.to_string())
        .bind(format!("{:#066x}", hash))
        .bind(timestamp.to_string())
        .execute(self.deref_mut())
        .await?;
        Ok(())
    }

    async fn get_head(&mut self) -> Result<Option<Head>, StoreError> {
        let rows = sqlx::query(
            "SELECT key, value FROM meta WHERE key IN ('head_height', 'head_hash', 'head_timestamp')",
        )
        .fetch_all(self.deref_mut())
        .await?;

        if rows.is_empty() {
            return Ok(None);
        }

        let mut height: Option<u64> = None;
        let mut hash: Option<String> = None;
        let mut timestamp: Option<u64> = None;

        for row in rows {
            let key: String = row.get("key");
            let value: String = row.get("value");
            match key.as_str() {
                "head_height" => height = value.parse().ok(),
                "head_hash" => hash = Some(value),
                "head_timestamp" => timestamp = value.parse().ok(),
                _ => {}
            }
        }

        match (height, hash, timestamp) {
            (Some(block_number), Some(block_hash), Some(timestamp)) => Ok(Some(Head {
                block_number,
                block_hash,
                timestamp,
            })),
            _ => Ok(None),
        }
    }

    async fn get_indexed_state(&mut self) -> Result<Option<IndexedState>, StoreError> {
        let rows = sqlx::query(
            "SELECT key, value FROM meta WHERE key IN ('indexed_height', 'indexed_hash')",
        )
        .fetch_all(self.deref_mut())
        .await?;

        if rows.is_empty() {
            return Ok(None);
        }

        let mut height: Option<u64> = None;
        let mut hash: Option<Felt> = None;

        for row in rows {
            let key: String = row.get("key");
            let value: String = row.get("value");
            match key.as_str() {
                "indexed_height" => height = value.parse().ok(),
                "indexed_hash" => hash = Felt::from_hex(&value).ok(),
                _ => {}
            }
        }

        match (height, hash) {
            (Some(block_height), Some(block_hash)) => Ok(Some(IndexedState {
                block_height,
                block_hash,
            })),
            _ => Ok(None),
        }
    }

    async fn set_indexed_state(&mut self, height: u64, hash: Felt) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT OR REPLACE INTO meta (key, value) \
            VALUES ('indexed_height', ?), ('indexed_hash', ?)",
        )
        .bind(height.to_string())
        .bind(format!("{:#066x}", hash))
        .execute(self.deref_mut())
        .await?;
        Ok(())
    }

    async fn batch_insert_storage_diffs(
        &mut self,
        height: u64,
        entries: &[(Felt, Felt)],
    ) -> Result<(), StoreError> {
        for (key, value) in entries {
            sqlx::query(
                "INSERT OR REPLACE INTO storage_diffs (block_height, key, value) VALUES (?, ?, ?)",
            )
            .bind(height as i64)
            .bind(format!("{:#066x}", key))
            .bind(format!("{:#066x}", value))
            .execute(self.deref_mut())
            .await?;
        }
        Ok(())
    }

    async fn commit(&mut self) -> Result<(), StoreError> {
        if SqliteTransactionManager::get_transaction_depth(self.deref_mut()) == 0 {
            return Ok(());
        }

        SqliteTransactionManager::commit(self.deref_mut())
            .await
            .map_err(|e| StoreError::Transaction(e.to_string()))
    }
}
