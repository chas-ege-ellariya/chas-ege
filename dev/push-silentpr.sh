#!/bin/bash
# Реализация переехала в push-silentpr.js (NodeJS). Обёртка для совместимости.
exec node "$(dirname "$0")/push-silentpr.js" "$@"
