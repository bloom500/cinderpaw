//! Where connector credentials live. One vault entry per (connector, field),
//! addressed by a `secret_ref` string that accounts and configs may carry
//! freely — it is a name, not a value.

pub const CONNECTOR_SERVICE: &str = "ai.bloom.feral.connectors";

pub fn secret_ref(connector_id: &str, field_key: &str) -> String {
    format!("connector:{connector_id}:{field_key}")
}

pub fn put(connector_id: &str, field_key: &str, value: &str) -> anyhow::Result<()> {
    crate::secret_store::set(CONNECTOR_SERVICE, &entry_of(connector_id, field_key), value)
}

pub fn read(secret_ref: &str) -> Option<String> {
    let entry = secret_ref.strip_prefix("connector:")?;
    crate::secret_store::get(CONNECTOR_SERVICE, entry)
}

pub fn forget(connector_id: &str, field_key: &str) -> anyhow::Result<()> {
    crate::secret_store::clear(CONNECTOR_SERVICE, &entry_of(connector_id, field_key))
}

fn entry_of(connector_id: &str, field_key: &str) -> String {
    format!("{connector_id}:{field_key}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_ref_is_stable_and_readable_back() {
        assert_eq!(secret_ref("matrix", "MATRIX_TOKEN"), "connector:matrix:MATRIX_TOKEN");
    }

    #[test]
    fn a_ref_from_put_reads_back_the_value() {
        if put("test-conn", "TEST_TOKEN", "s3cret").is_err() {
            eprintln!("no secret backend available; skipping");
            return;
        }
        let r = secret_ref("test-conn", "TEST_TOKEN");
        assert_eq!(read(&r).as_deref(), Some("s3cret"));
        forget("test-conn", "TEST_TOKEN").expect("forget");
        assert_eq!(read(&r), None);
    }
}
