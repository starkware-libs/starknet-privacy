//! Flat wire format for `BlockId`: `"0x..."` (hash), `123` (number),
//! or `"latest"` / `"pre_confirmed"` / `"l1_accepted"` (tag).

use serde::de::{self, Deserializer};
use serde::ser::Serializer;
use serde::Serialize;
use starknet_core::types::{BlockId, BlockTag, Felt};

pub fn serialize<S: Serializer>(id: &BlockId, serializer: S) -> Result<S::Ok, S::Error> {
    match id {
        BlockId::Hash(felt) => serializer.serialize_str(&format!("{felt:#x}")),
        BlockId::Number(n) => serializer.serialize_u64(*n),
        BlockId::Tag(tag) => tag.serialize(serializer),
    }
}

pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<BlockId, D::Error> {
    deserializer.deserialize_any(FlatBlockIdVisitor)
}

struct FlatBlockIdVisitor;

impl<'de> de::Visitor<'de> for FlatBlockIdVisitor {
    type Value = BlockId;

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a hex string (\"0x...\"), an integer, or a block tag string")
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<BlockId, E> {
        Ok(BlockId::Number(value))
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<BlockId, E> {
        match value {
            "latest" => Ok(BlockId::Tag(BlockTag::Latest)),
            "pre_confirmed" => Ok(BlockId::Tag(BlockTag::PreConfirmed)),
            "l1_accepted" => Ok(BlockId::Tag(BlockTag::L1Accepted)),
            hex if hex.starts_with("0x") || hex.starts_with("0X") => Felt::from_hex(hex)
                .map(BlockId::Hash)
                .map_err(de::Error::custom),
            other => Err(de::Error::custom(format!(
                "unknown block tag or invalid hex: {other}"
            ))),
        }
    }
}

/// For `Option<BlockId>` fields.
pub mod option {
    use super::*;

    pub fn serialize<S: Serializer>(
        id: &Option<BlockId>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match id {
            Some(id) => super::serialize(id, serializer),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<BlockId>, D::Error> {
        struct OptionVisitor;

        impl<'de> de::Visitor<'de> for OptionVisitor {
            type Value = Option<BlockId>;

            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("null, a hex string, an integer, or a block tag string")
            }

            fn visit_none<E: de::Error>(self) -> Result<Option<BlockId>, E> {
                Ok(None)
            }

            fn visit_unit<E: de::Error>(self) -> Result<Option<BlockId>, E> {
                Ok(None)
            }

            fn visit_some<D2: Deserializer<'de>>(
                self,
                deserializer: D2,
            ) -> Result<Option<BlockId>, D2::Error> {
                super::deserialize(deserializer).map(Some)
            }

            fn visit_u64<E: de::Error>(self, value: u64) -> Result<Option<BlockId>, E> {
                Ok(Some(BlockId::Number(value)))
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<Option<BlockId>, E> {
                FlatBlockIdVisitor.visit_str(value).map(Some)
            }
        }

        deserializer.deserialize_any(OptionVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Required {
        #[serde(with = "super")]
        block_ref: BlockId,
    }

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Optional {
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            with = "super::option"
        )]
        block_ref: Option<BlockId>,
    }

    #[test]
    fn round_trip_hash() {
        let original = Required {
            block_ref: BlockId::Hash(Felt::from_hex_unchecked("0xdeadbeef")),
        };
        let json = serde_json::to_string(&original).unwrap();
        assert_eq!(json, r#"{"block_ref":"0xdeadbeef"}"#);
        let decoded: Required = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn round_trip_number() {
        let original = Required {
            block_ref: BlockId::Number(42),
        };
        let json = serde_json::to_string(&original).unwrap();
        assert_eq!(json, r#"{"block_ref":42}"#);
        let decoded: Required = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn round_trip_latest() {
        let original = Required {
            block_ref: BlockId::Tag(BlockTag::Latest),
        };
        let json = serde_json::to_string(&original).unwrap();
        assert_eq!(json, r#"{"block_ref":"latest"}"#);
        let decoded: Required = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn round_trip_pre_confirmed() {
        let original = Required {
            block_ref: BlockId::Tag(BlockTag::PreConfirmed),
        };
        let json = serde_json::to_string(&original).unwrap();
        assert_eq!(json, r#"{"block_ref":"pre_confirmed"}"#);
        let decoded: Required = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn round_trip_l1_accepted() {
        let original = Required {
            block_ref: BlockId::Tag(BlockTag::L1Accepted),
        };
        let json = serde_json::to_string(&original).unwrap();
        assert_eq!(json, r#"{"block_ref":"l1_accepted"}"#);
        let decoded: Required = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn option_none_omitted() {
        let original = Optional { block_ref: None };
        let json = serde_json::to_string(&original).unwrap();
        assert_eq!(json, "{}");
        let decoded: Optional = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn option_some_round_trips() {
        let original = Optional {
            block_ref: Some(BlockId::Hash(Felt::from_hex_unchecked("0xabc"))),
        };
        let json = serde_json::to_string(&original).unwrap();
        assert_eq!(json, r#"{"block_ref":"0xabc"}"#);
        let decoded: Optional = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn option_null_is_none() {
        let decoded: Optional = serde_json::from_str(r#"{"block_ref":null}"#).unwrap();
        assert_eq!(decoded.block_ref, None);
    }

    #[test]
    fn rejects_unknown_tag() {
        let result = serde_json::from_str::<Required>(r#"{"block_ref":"bogus"}"#);
        assert!(result.is_err());
    }

    #[test]
    fn rejects_invalid_hex() {
        let result = serde_json::from_str::<Required>(r#"{"block_ref":"0xZZZ"}"#);
        assert!(result.is_err());
    }
}
