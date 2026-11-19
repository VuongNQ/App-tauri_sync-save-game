//! Consistency checks for tokens obtained directly from Firebase over HTTPS.
//! This is NOT a JWT signature verifier. Firestore/Firebase verify signatures;
//! these checks bind the trusted response to our project and Google namespace.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

pub fn validate_firebase_identity(
    token: &str,
    project: &str,
    uid: &str,
    google_id: &str,
) -> Result<(), String> {
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 3 || project.is_empty() || uid.is_empty() || google_id.is_empty() {
        return Err("Invalid Firebase identity response".into());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|_| "Invalid Firebase identity response")?;
    let claims: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid Firebase identity response")?;
    let expected_issuer = format!("https://securetoken.google.com/{project}");
    let linked_google = claims
        .pointer("/firebase/identities/google.com")
        .and_then(|v| v.as_array())
        .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(google_id)));
    if claims["aud"].as_str() != Some(project)
        || claims["iss"].as_str() != Some(expected_issuer.as_str())
        || claims["sub"].as_str() != Some(uid)
        || !linked_google
    {
        return Err("Firebase identity does not match this project and Google account".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn token(project: &str, google: &str) -> String {
        let payload = serde_json::json!({"aud":project,"iss":format!("https://securetoken.google.com/{project}"),"sub":"firebase-uid", "firebase":{"identities":{"google.com":[google]}}});
        format!(
            "header.{}.signature",
            URL_SAFE_NO_PAD.encode(payload.to_string())
        )
    }
    #[test]
    fn firebase_uid_does_not_replace_legacy_google_namespace() {
        assert!(validate_firebase_identity(
            &token("project-a", "123"),
            "project-a",
            "firebase-uid",
            "123"
        )
        .is_ok());
    }
    #[test]
    fn rejects_wrong_account_project_uid_and_malformed_response() {
        assert!(validate_firebase_identity(
            &token("project-a", "123"),
            "project-a",
            "firebase-uid",
            "456"
        )
        .is_err());
        assert!(validate_firebase_identity(
            &token("project-a", "123"),
            "project-b",
            "firebase-uid",
            "123"
        )
        .is_err());
        assert!(
            validate_firebase_identity(&token("project-a", "123"), "project-a", "123", "123")
                .is_err()
        );
        assert!(
            validate_firebase_identity("not-a-token", "project-a", "firebase-uid", "123").is_err()
        );
    }
}
