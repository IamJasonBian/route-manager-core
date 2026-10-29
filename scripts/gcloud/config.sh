# Shared GCP config for the auth + credential scripts.
# Source this from other scripts:  . "$(dirname "$0")/config.sh"

# GCP project that owns the Secret Manager secrets and the ADC quota.
export GCP_PROJECT="${GCP_PROJECT:-allocation-agent-service}"

# Secret Manager secret names holding the delta.com login.
export DELTA_USERNAME_SECRET="${DELTA_USERNAME_SECRET:-delta-com-username}"
export DELTA_PASSWORD_SECRET="${DELTA_PASSWORD_SECRET:-delta-com-password}"

# Secret Manager secret names holding the aa.com (American Airlines) login.
# Username is the AAdvantage number or registered email.
export AA_USERNAME_SECRET="${AA_USERNAME_SECRET:-aa-com-username}"
export AA_PASSWORD_SECRET="${AA_PASSWORD_SECRET:-aa-com-password}"
