//! Stub implementation of ClassManagerClient for sync-only nodes.
//!
//! This stub works for header and state_diff streams which don't actually use the ClassManagerClient.
//! Only the Class stream uses it, so if you're not syncing classes, this stub is sufficient.

use apollo_class_manager_types::{
    Class,
    ClassHashes,
    ClassId,
    ClassManagerClient,
    ClassManagerClientResult,
    ExecutableClass,
    ExecutableClassHash,
};
use async_trait::async_trait;
use starknet_api::deprecated_contract_class::ContractClass as DeprecatedClass;

/// A stub ClassManagerClient that returns empty/default values.
///
/// This is sufficient for syncing headers and state diffs, as those streams
/// don't actually use the class manager client (the parameter is named `_class_manager_client`).
pub struct StubClassManagerClient;

#[async_trait]
impl ClassManagerClient for StubClassManagerClient {
    async fn add_class(&self, _class: Class) -> ClassManagerClientResult<ClassHashes> {
        // This should not be called when only syncing headers + state_diffs.
        // If it is called, return default values.
        Ok(ClassHashes::default())
    }

    async fn get_executable(
        &self,
        _class_id: ClassId,
    ) -> ClassManagerClientResult<Option<ExecutableClass>> {
        Ok(None)
    }

    async fn get_sierra(&self, _class_id: ClassId) -> ClassManagerClientResult<Option<Class>> {
        Ok(None)
    }

    async fn get_executable_class_hash_v2(
        &self,
        _class_id: ClassId,
    ) -> ClassManagerClientResult<Option<ExecutableClassHash>> {
        Ok(None)
    }

    async fn add_deprecated_class(
        &self,
        _class_id: ClassId,
        _class: DeprecatedClass,
    ) -> ClassManagerClientResult<()> {
        Ok(())
    }

    async fn add_class_and_executable_unsafe(
        &self,
        _class_id: ClassId,
        _class: Class,
        _executable_class_hash_v2: ExecutableClassHash,
        _executable_class: ExecutableClass,
    ) -> ClassManagerClientResult<()> {
        Ok(())
    }
}
