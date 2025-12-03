use starkware_utils::errors::{Describable, ErrorDisplay};

#[derive(Drop)]
pub enum Error {
    VIEWING_KEY_ALREADY_EXISTS,
    COMPLIANCE_VIEWING_KEY_ALREADY_EXISTS,
}

impl DescribableError of Describable<Error> {
    fn describe(self: @Error) -> ByteArray {
        match self {
            Error::VIEWING_KEY_ALREADY_EXISTS => "Viewing key already exists",
            Error::COMPLIANCE_VIEWING_KEY_ALREADY_EXISTS => "Compliance viewing key already exists",
        }
    }
}
