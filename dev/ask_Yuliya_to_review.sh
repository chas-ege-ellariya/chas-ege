#!/bin/bash
# Юлия: мелочи в коде (опечатки, пропущенные ';' и прочее такое вот).
# Профили Chromium: yuliya-auto-*. Вся логика вызова — в dev/lib/ask_to_review.sh.
exec bash "$(dirname "$0")/lib/ask_to_review.sh" Yuliya yuliya-auto "$1"
