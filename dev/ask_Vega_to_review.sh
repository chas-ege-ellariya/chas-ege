#!/bin/bash
# Вега: лексический модуль (sklonlxkand, chislitlx, chislit и компания).
# Профили Chromium: vega-auto-*. Вся логика вызова — в dev/lib/ask_to_review.sh.
exec bash "$(dirname "$0")/lib/ask_to_review.sh" Vega vega-auto "$1"
