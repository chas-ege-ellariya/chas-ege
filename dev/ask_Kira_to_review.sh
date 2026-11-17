#!/bin/bash
# Кира: ревью на предмет соблюдения DRY.
# Профили Chromium: kira-auto-*. Вся логика вызова — в dev/lib/ask_to_review.sh.
exec bash "$(dirname "$0")/lib/ask_to_review.sh" Kira kira-auto "$1"
