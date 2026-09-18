import { BUILD_TARGET } from "./platform/build-target";
import { getExtensionApi } from "./platform/api";
import { installLocalMonitorRuntime } from "./runtime/local-monitor-runtime";

import { installFirstRunSetup } from "./ui/first-run.js";

const api = getExtensionApi();
installFirstRunSetup(api);
// Errors remain fail-closed: the packaged app sees no controller rather than
// acquiring a direct storage/network fallback. The runtime itself keeps
// upstream failures as `unknown` in its persisted monitor state.
installLocalMonitorRuntime({ api, target: BUILD_TARGET });
