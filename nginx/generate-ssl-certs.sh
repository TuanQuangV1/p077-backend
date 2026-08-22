#!/usr/bin/env bash
# Generate self-signed SSL certs for nginx (IP + localhost).
# Called from Dockerfile during build so certs are baked into the image.
set -euo pipefail

CERT_DIR="${1:-/etc/nginx/certs}"
DAYS=365

mkdir -p "$CERT_DIR"

# Generate CA key + cert (root of trust for the self-signed chain)
openssl genrsa -out "$CERT_DIR/ca.key" 2048 2>/dev/null
openssl req -x509 -new -nodes -key "$CERT_DIR/ca.key" \
  -sha256 -days "$DAYS" \
  -out "$CERT_DIR/ca.crt" \
  -subj "/CN=AI20K Self-Signed CA"

# Create OpenSSL config with SAN for both IP and localhost
cat > "$CERT_DIR/san.cnf" <<EOF
[req]
default_bits       = 2048
prompt             = no
default_md         = sha256
distinguished_name = dn
x509_extensions    = v3_req

[dn]
CN = AI20K P-077

[v3_req]
subjectAltName = @alt_names

[alt_names]
IP.1  = 34.21.210.223
DNS.1 = localhost
DNS.2 = 127.0.0.1
EOF

# Generate server key + CSR
openssl genrsa -out "$CERT_DIR/privkey.pem" 2048 2>/dev/null
openssl req -new -key "$CERT_DIR/privkey.pem" \
  -out "$CERT_DIR/server.csr" \
  -config "$CERT_DIR/san.cnf"

# Sign with CA
openssl x509 -req -in "$CERT_DIR/server.csr" \
  -CA "$CERT_DIR/ca.crt" -CAkey "$CERT_DIR/ca.key" -CAcreateserial \
  -out "$CERT_DIR/fullchain.pem" \
  -days "$DAYS" -sha256 \
  -extensions v3_req \
  -extfile "$CERT_DIR/san.cnf"

# Cleanup temp files
rm -f "$CERT_DIR/ca.key" "$CERT_DIR/ca.srl" "$CERT_DIR/server.csr" "$CERT_DIR/san.cnf"

chmod 600 "$CERT_DIR/privkey.pem"
chmod 644 "$CERT_DIR/fullchain.pem"

echo "[ssl] certs generated in $CERT_DIR"
