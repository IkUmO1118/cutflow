// swift-tools-version: 5.9
//
// Vendored + trimmed from OpenScreen (MIT). See ../PROVENANCE.md. Upstream's
// Package.swift defines two executable targets (a ScreenCaptureKit capture
// helper + this cursor helper); CutFlow only vendors the cursor helper (the
// capture helper is OUT — CutFlow keeps OBS as the capture stack), so this
// copy keeps just the one target. Not on CutFlow's build-time critical path:
// `doctor` builds this file directly with `swiftc` (no external package
// dependencies), this manifest exists for reference-build parity with
// upstream (`swift build`) and provenance.

import PackageDescription

let package = Package(
	name: "CutFlowCursorHelper",
	platforms: [
		.macOS(.v13)
	],
	products: [
		.executable(
			name: "cutflow-cursor-helper",
			targets: ["OpenScreenMacOSCursorHelper"]
		)
	],
	targets: [
		.executableTarget(
			name: "OpenScreenMacOSCursorHelper",
			path: "."
		)
	]
)
