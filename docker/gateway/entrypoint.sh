#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

set -eu
mkdir -p /etc/nginx/certs
if [ ! -s /etc/nginx/certs/dstns.crt ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj '/CN=localhost/O=DSTNS Development' -keyout /etc/nginx/certs/dstns.key -out /etc/nginx/certs/dstns.crt >/dev/null 2>&1
fi
exec nginx -g 'daemon off;'
