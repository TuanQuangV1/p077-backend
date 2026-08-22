FROM nginx:1.25-alpine

RUN apk add --no-cache openssl bash

COPY generate-ssl-certs.sh /usr/local/bin/generate-ssl-certs.sh
RUN chmod +x /usr/local/bin/generate-ssl-certs.sh

RUN /usr/local/bin/generate-ssl-certs.sh /etc/nginx/certs
