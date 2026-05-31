# Account Management

## Password reset

If you forgot your password, click "Forgot password" on the login page. We email a reset link valid for 1 hour. If you don't receive it within 5 minutes, check spam, then try again.

Resetting password does not log out other active sessions. To force everyone out, use **Settings → Security → Sign out all sessions**.

## Two-factor authentication

We support TOTP (Google Authenticator, 1Password, Authy) on all plans. Enable at **Settings → Security → Two-factor**.

SMS-based 2FA is **not** supported (security risk).

If you lose access to your TOTP device, use a recovery code (generated when you enabled 2FA). If you don't have recovery codes, contact support for identity verification — we'll need to confirm billing details and recent activity before we can disable 2FA.

## Single sign-on (SSO)

Basic SSO (Google, Microsoft) is on Pro+. Configure at **Settings → Security → SSO**.

Advanced SSO (Okta, OneLogin, generic SAML) is Enterprise-only. We'll provide the metadata XML for your IdP after a kickoff call.

## Closing an account

Self-service close: **Settings → Billing → Cancel subscription**. Takes effect at end of billing period. Data is exported and emailed to the billing contact. After 90 days, all data is deleted permanently.

For immediate deletion (GDPR right-to-erasure), open a support ticket. We complete deletion within 30 days of request and confirm via email.

## Changing the account owner

Account owner can be transferred. The new owner must be an active user on the account. Use **Settings → Users → Transfer ownership**. The current owner becomes a regular admin; only one owner at a time.

For transferring ownership outside the current user base (e.g., the original owner left the company), we require:
1. Email from a verified billing contact, OR
2. Letter on company letterhead with the new owner's contact info.
