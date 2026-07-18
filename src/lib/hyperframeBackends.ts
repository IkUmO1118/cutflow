import { CDN_PINS } from "./hyperframeCdn.ts";
import {
  HYPERFRAME_REQUIRE_TOKENS,
  type HyperframeRequireToken,
} from "./hyperframeRequirements.ts";
import { isHyperframeRenderProfileWired } from "./hyperframeRenderProfile.ts";

export type HyperframeBackendStatus = "usable" | "material-routed" | "not-wired" | "out";
export type HyperframeDeterminismTier = "byte" | "perceptual";
export type HyperframeAuthoringRoute = "manual" | "material-import" | "from-brief";

export interface HyperframeBackendPin {
  lib: string;
  version: string;
  url: string;
}

export interface HyperframeBackend {
  id: string;
  status: HyperframeBackendStatus;
  determinismTiers: HyperframeDeterminismTier[];
  pin: HyperframeBackendPin | null;
  authoring: HyperframeAuthoringRoute[];
  renderFixture: string | null;
}

export interface HyperframeBackendsReport {
  schemaVersion: 1;
  backends: HyperframeBackend[];
}

type BackendCapability =
  | { kind: "native" }
  | { kind: "pinned"; token: HyperframeRequireToken }
  | { kind: "material"; token: HyperframeRequireToken }
  | { kind: "gpu" }
  | { kind: "gpu-pinned"; token: HyperframeRequireToken }
  | { kind: "out" };

interface BackendDefinition {
  id: string;
  capability: BackendCapability;
  determinismTiers: readonly HyperframeDeterminismTier[];
  authoring: readonly HyperframeAuthoringRoute[];
  renderFixture: string | null;
}

const FIXTURE_DIR = "test/fixtures/hyperframe-backends";

// Stable display order. Status and pins are deliberately absent: they are
// resolved below from the pin table, Rule 8 tokens, and render profile wiring.
const BACKEND_DEFINITIONS: readonly BackendDefinition[] = [
  { id: "css", capability: { kind: "native" }, determinismTiers: ["byte"], authoring: ["manual", "from-brief"], renderFixture: `${FIXTURE_DIR}/css.html` },
  { id: "waapi", capability: { kind: "native" }, determinismTiers: ["byte"], authoring: ["manual", "from-brief"], renderFixture: `${FIXTURE_DIR}/waapi.html` },
  { id: "svg", capability: { kind: "native" }, determinismTiers: ["byte"], authoring: ["manual", "from-brief"], renderFixture: `${FIXTURE_DIR}/svg.html` },
  { id: "dom", capability: { kind: "native" }, determinismTiers: ["byte"], authoring: ["manual", "from-brief"], renderFixture: `${FIXTURE_DIR}/dom.html` },
  { id: "canvas-2d", capability: { kind: "native" }, determinismTiers: ["perceptual"], authoring: ["manual", "from-brief"], renderFixture: `${FIXTURE_DIR}/canvas-2d.html` },
  { id: "gsap", capability: { kind: "pinned", token: "gsap" }, determinismTiers: ["byte"], authoring: ["manual"], renderFixture: `${FIXTURE_DIR}/gsap.html` },
  { id: "lottie", capability: { kind: "material", token: "lottie" }, determinismTiers: ["byte", "perceptual"], authoring: ["material-import"], renderFixture: null },
  { id: "raw-webgl", capability: { kind: "gpu" }, determinismTiers: ["perceptual"], authoring: ["manual"], renderFixture: `${FIXTURE_DIR}/raw-webgl.html` },
  { id: "three", capability: { kind: "gpu-pinned", token: "three" }, determinismTiers: ["perceptual"], authoring: ["manual"], renderFixture: null },
  { id: "anime-js", capability: { kind: "out" }, determinismTiers: [], authoring: [], renderFixture: null },
  { id: "d3", capability: { kind: "out" }, determinismTiers: [], authoring: [], renderFixture: null },
  { id: "typegpu", capability: { kind: "out" }, determinismTiers: [], authoring: [], renderFixture: null },
  { id: "maps", capability: { kind: "out" }, determinismTiers: [], authoring: [], renderFixture: null },
  { id: "dotlottie", capability: { kind: "out" }, determinismTiers: [], authoring: [], renderFixture: null },
];

function pinFor(token: HyperframeRequireToken): HyperframeBackendPin | null {
  const pin = CDN_PINS.find((candidate) => candidate.lib === token);
  if (!pin) return null;
  const version = /@([^/]+)\//.exec(pin.url)?.[1];
  if (!version) throw new Error(`CDN pin URL has no version: ${pin.url}`);
  return { lib: pin.lib, version, url: pin.url };
}

function resolveBackend(definition: BackendDefinition): HyperframeBackend {
  const capability = definition.capability;
  const knownTokens = new Set<string>(HYPERFRAME_REQUIRE_TOKENS);
  const pin = "token" in capability ? pinFor(capability.token) : null;
  let status: HyperframeBackendStatus;

  switch (capability.kind) {
    case "native": status = "usable"; break;
    case "pinned": status = knownTokens.has(capability.token) && pin ? "usable" : "not-wired"; break;
    case "material": status = knownTokens.has(capability.token) && pin ? "material-routed" : "not-wired"; break;
    case "gpu": status = isHyperframeRenderProfileWired("gpu-angle") ? "usable" : "not-wired"; break;
    case "gpu-pinned": status = knownTokens.has(capability.token) && pin && isHyperframeRenderProfileWired("gpu-angle") ? "usable" : "not-wired"; break;
    case "out": status = "out"; break;
  }

  return {
    id: definition.id,
    status,
    determinismTiers: [...definition.determinismTiers],
    pin,
    authoring: [...definition.authoring],
    renderFixture: status === "usable" ? definition.renderFixture : null,
  };
}

export function hyperframeBackends(): HyperframeBackendsReport {
  return {
    schemaVersion: 1,
    backends: BACKEND_DEFINITIONS.map(resolveBackend),
  };
}

export function formatHyperframeBackends(report = hyperframeBackends()): string {
  return [
    `HyperFrame backends (schemaVersion ${report.schemaVersion})`,
    ...report.backends.map((backend) => {
      const tiers = backend.determinismTiers.length > 0 ? backend.determinismTiers.join(",") : "n/a";
      const pin = backend.pin ? `${backend.pin.lib}@${backend.pin.version} ${backend.pin.url}` : "none";
      const authoring = backend.authoring.length > 0 ? backend.authoring.join(",") : "none";
      const fixture = backend.renderFixture ?? "none";
      return `- ${backend.id}: ${backend.status}; determinism=${tiers}; pin=${pin}; authoring=${authoring}; fixture=${fixture}`;
    }),
  ].join("\n");
}
