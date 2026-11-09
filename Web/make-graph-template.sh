#!/bin/sh
# Embeds Web/graph.html into the app as a Swift string (no bundle resources needed on macOS or iOS).
# Run after editing graph.html:  sh Web/make-graph-template.sh
cd "$(dirname "$0")/.."
out=App/Shared/Views/Graph/GraphTemplate.swift
{
  echo '// Generated from Web/graph.html by Web/make-graph-template.sh — edit the HTML, then rerun the script.'
  echo 'enum GraphTemplate {'
  echo '    static let html = ##"""'
  cat Web/graph.html
  echo '"""##'
  echo '}'
} > "$out"
echo "wrote $out"
