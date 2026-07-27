// Resolve konva in whichever environment the op runs in, without editing this file:
// - editor / npm: op.require("konva")
// - exported / online: konva attached as a CDN commonjs resource that sets a global
//   (https://cdn.jsdelivr.net/npm/konva@10.3.0/konva.min.js)
const Konva = (() =>
{
    if (typeof op.require === "function")
    {
        try
        {
            const m = op.require("konva");
            if (m) return m.default || m;
        }
        catch (e) { /* not available here, fall through to global */ }
    }
    return (typeof globalThis !== "undefined" && globalThis.Konva) || null;
})();

if (!Konva) op.setUiError("konva", "Konva library not found (needs the npm dependency in the editor, or a konva CDN commonjs resource in the export).");
else op.setUiError("konva", null);

const
    inStoreData = op.inString("Stored Automata Data", ""),
    exec = op.inTrigger("Trigger"),
    next = op.outTrigger("Next"),
    inShow = op.inTriggerButton("Show Tab"),
    resetTargetIn = op.inDropDown("Reset Target", ["START"], "START"),
    resetIn = op.inTriggerButton("Reset"),
    outActiveState = op.outString("Active State"),
    frameCounterOut = op.outNumber("State Frames"),
    outTransitionCountdownOut = op.outNumber("Transition Countdown"),
    outStates = op.outArray("States");

inStoreData.setUiAttribs({ "hidePort": true, "greyout": true });
inShow.setUiAttribs({ "hidePort": true });

// --- Dynamic transition triggers (driven by inStoreData) ---
const createdTriggers = new Map();
let parsedData = { states: [], transitions: [], regions: [] };
let currentActiveStateId = null;
let onActiveStateChanged = null;
let stateFrames = 0;
let resetTargets = [];
let currentActiveTransitionId = null;
let onTransitionActivityChanged = null;
let pendingTransition = null;
// Region "active" output ports, owned at op scope (not by the editor tab) so
// they are recreated from stored data on reload, like the transition triggers.
const regionActiveOutputs = new Map();
const STATE_RADIUS = 50;
const REGION_INACTIVE_FILL = "rgba(64, 180, 255, 0.12)";
const REGION_INACTIVE_STROKE = "rgba(64, 180, 255, 0.50)";
const REGION_ACTIVE_FILL = "rgba(64, 180, 255, 0.22)";
const REGION_ACTIVE_STROKE = "rgba(120, 220, 255, 0.88)";
const REGION_INACTIVE_TITLE_FILL = "rgba(220, 240, 255, 0.95)";
const REGION_ACTIVE_TITLE_FILL = "rgba(245, 252, 255, 1)";

function sanitizeFrames(value)
{
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function getNormalizedTransitionCountdown()
{
    if (!pendingTransition || pendingTransition.frames <= 0) return 0;

    const remainingFrames = Math.max(pendingTransition.frames - pendingTransition.elapsed, 0);
    return remainingFrames / pendingTransition.frames;
}

function updateTransitionCountdownOutput()
{
    outTransitionCountdownOut.set(getNormalizedTransitionCountdown());
}

function setActiveTransitionId(id)
{
    currentActiveTransitionId = id || null;
    if (onTransitionActivityChanged) onTransitionActivityChanged(currentActiveTransitionId);
}

function cancelPendingTransition()
{
    pendingTransition = null;
    setActiveTransitionId(null);
    updateTransitionCountdownOutput();
}

function startTransition(transition)
{
    if (!transition) return;
    const frames = sanitizeFrames(transition.frames);

    if (frames <= 0)
    {
        cancelPendingTransition();
        setActiveStateId(transition.to);
        return;
    }

    pendingTransition = {
        id: transition.id,
        from: transition.from,
        to: transition.to,
        frames: frames,
        elapsed: 0,
    };
    setActiveTransitionId(transition.id);
    updateTransitionCountdownOutput();
}

function updateFrameCounterOutput()
{
    frameCounterOut.set(stateFrames);
}

// One simulation step, advanced exactly once per trigger (i.e. once per rendered
// frame when this op is connected into the main loop's trigger chain). Counting
// triggers makes "frames" an actual frame count rather than a wall-clock estimate,
// and means the automata stops when the op is disconnected, like any other op.
function advanceFrame()
{
    stateFrames += 1;

    if (pendingTransition)
    {
        pendingTransition.elapsed += 1;
        if (pendingTransition.elapsed >= pendingTransition.frames)
        {
            const nextStateId = pendingTransition.to;
            pendingTransition = null;
            setActiveTransitionId(null);
            setActiveStateId(nextStateId); // resets stateFrames to 0
        }
    }

    updateFrameCounterOutput();
    updateTransitionCountdownOutput();
}

op.onDelete = () =>
{
    if (konvaState)
    {
        if (konvaState.resizeObserver) konvaState.resizeObserver.disconnect();
        if (konvaState.stage) konvaState.stage.destroy();
    }

    if (konvaTab && gui && gui.mainTabs && typeof gui.mainTabs.closeTab === "function")
    {
        gui.mainTabs.closeTab(konvaTab.id);
    }

    onActiveStateChanged = null;
    onTransitionActivityChanged = null;
    konvaState = null;
    konvaTab = null;
};

function parseStoredData()
{
    try
    {
        const stored = inStoreData.get();
        const data = stored ? JSON.parse(stored) : null;
        parsedData = {
            states: data && Array.isArray(data.states) ? data.states : [],
            transitions: data && Array.isArray(data.transitions) ? data.transitions : [],
            regions: data && Array.isArray(data.regions) ? data.regions : [],
        };
    }
    catch (e)
    {
        parsedData = { states: [], transitions: [], regions: [] };
    }
}

function getStateLabel(id)
{
    const s = parsedData.states.find((x) => x && x.id === id);
    return s && typeof s.label === "string" && s.label.trim().length > 0 ? s.label : id;
}

function getResetTargetLabel(state, counts)
{
    const baseLabel = state && typeof state.label === "string" && state.label.trim().length > 0
        ? state.label.trim()
        : String(state.id);

    return counts.get(baseLabel) > 1
        ? baseLabel + " (" + state.id + ")"
        : baseLabel;
}

function getStartStateId()
{
    const startState = parsedData.states.find(
        (state) => state && state.id && typeof state.label === "string" && state.label.trim() === "START"
    );
    return startState ? String(startState.id) : null;
}

function getDefaultResetTargetId()
{
    return getStartStateId() || (resetTargets[0] ? resetTargets[0].id : null);
}

function updateResetTargets()
{
    const counts = new Map();
    parsedData.states.forEach((state) =>
    {
        if (!state || !state.id) return;
        const baseLabel = typeof state.label === "string" && state.label.trim().length > 0
            ? state.label.trim()
            : String(state.id);
        counts.set(baseLabel, (counts.get(baseLabel) || 0) + 1);
    });

    resetTargets = parsedData.states
        .filter((state) => state && state.id)
        .map((state) => ({
            id: String(state.id),
            label: getResetTargetLabel(state, counts),
        }));

    const targetLabels = resetTargets.map((target) => target.label);
    // Dropdown needs a non-empty option list; fall back to the default "START"
    // so we never push an empty value (which cables flags as "Invalid Value").
    const values = targetLabels.length ? targetLabels : ["START"];
    const selectedLabel = typeof resetTargetIn.get === "function" && typeof resetTargetIn.get() === "string"
        ? resetTargetIn.get()
        : "";
    const selectedExists = values.includes(selectedLabel);
    const defaultTargetId = getDefaultResetTargetId();
    const defaultTarget = resetTargets.find((target) => target.id === defaultTargetId);
    const fallbackLabel = defaultTarget
        ? defaultTarget.label
        : (resetTargets[0] ? resetTargets[0].label : "");
    const nextValue = selectedExists ? selectedLabel : fallbackLabel;

    resetTargetIn.setUiAttribs({ "values": values });
    resetTargetIn.set(values.includes(nextValue) ? nextValue : values[0]);
    outStates.set(targetLabels);
}

function getResetTargetId()
{
    const selectedLabel = resetTargetIn.get();
    const target = resetTargets.find((item) => item.label === selectedLabel);
    return target ? target.id : getDefaultResetTargetId();
}

function getRegionTitle(region)
{
    return typeof region.title === "string" && region.title.trim().length > 0
        ? region.title.trim()
        : String(region.id);
}

// Stable port name from the immutable region id (link key, never changes).
function getRegionActiveOutputName(region)
{
    return region && region.id ? String(region.id) + "-active" : null;
}

// Readable display title; disambiguated with the id only when two regions
// share a title. Changing this never affects links.
function getRegionActiveOutputTitle(region)
{
    if (!region || !region.id) return "";

    const baseTitle = getRegionTitle(region) + " Active";
    const hasDuplicateTitle = parsedData.regions.some((other) =>
        other
        && other.id !== region.id
        && (getRegionTitle(other) + " Active") === baseTitle
    );

    return hasDuplicateTitle ? baseTitle + " (" + region.id + ")" : baseTitle;
}

function ensureRegionActiveOutput(region)
{
    if (!region || !region.id) return null;

    const title = getRegionActiveOutputTitle(region);
    const existingEntry = regionActiveOutputs.get(region.id);
    if (existingEntry && existingEntry.port)
    {
        if (existingEntry.title !== title)
        {
            existingEntry.title = title;
            existingEntry.port.setUiAttribs({ "title": title });
        }
        return existingEntry.port;
    }

    const port = op.outNumber(getRegionActiveOutputName(region));
    port.setUiAttribs({ "title": title });
    regionActiveOutputs.set(region.id, { port, title });
    return port;
}

function removeRegionActiveOutput(regionId)
{
    const entry = regionActiveOutputs.get(regionId);
    if (!entry) return;

    if (entry.port && typeof op.removePort === "function") op.removePort(entry.port);
    regionActiveOutputs.delete(regionId);
}

function isStateInsideRegion(state, region)
{
    if (!state || !region) return false;
    if (![state.x, state.y, region.x, region.y, region.radius].every(Number.isFinite)) return false;
    const dx = state.x - region.x;
    const dy = state.y - region.y;
    return Math.sqrt(dx * dx + dy * dy) <= region.radius + STATE_RADIUS;
}

// Recreate/rename/remove region output ports from stored data and push their
// current active values. Runs at op init and on every data change, so region
// outputs exist and are correct on reload without opening the editor tab.
function syncRegionActivityOutputs()
{
    const regionIds = new Set(
        parsedData.regions.filter((region) => region && region.id).map((region) => String(region.id))
    );

    Array.from(regionActiveOutputs.keys())
        .filter((id) => !regionIds.has(id))
        .forEach(removeRegionActiveOutput);

    const activeState = parsedData.states.find((state) => state && state.id === currentActiveStateId) || null;

    parsedData.regions.forEach((region) =>
    {
        if (!region || !region.id) return;
        const port = ensureRegionActiveOutput(region);
        if (port) port.set(isStateInsideRegion(activeState, region) ? 1 : 0);
    });
}

function refreshInspector()
{
    if (!CABLES.UI || typeof gui !== "object" || !gui) return;

    const selectedOp = gui.patchView && typeof gui.patchView.getSelectedOp === "function"
        ? gui.patchView.getSelectedOp()
        : gui.opParams && gui.opParams.op
            ? gui.opParams.op
            : null;

    if (selectedOp !== op) return;

    if (gui.opParams && typeof gui.opParams.show === "function")
    {
        gui.opParams.show(op);
        return;
    }

    if (gui.patchView && typeof gui.patchView.selectOp === "function")
    {
        gui.patchView.selectOp(op);
        return;
    }

    if (typeof gui.selectOp === "function")
    {
        gui.selectOp(op);
    }
}

function setActiveStateId(id)
{
    currentActiveStateId = id;
    stateFrames = 0;
    updateFrameCounterOutput();
    outActiveState.set(id ? getStateLabel(id) : "");
    syncRegionActivityOutputs();
    if (onActiveStateChanged) onActiveStateChanged(id);
}

resetIn.onTriggered = () =>
{
    const targetId = getResetTargetId();
    if (!targetId) return;
    cancelPendingTransition();
    setActiveStateId(targetId);
};

function getTransitionInfos()
{
    return parsedData.transitions
        .filter((t) => t && typeof t.from === "string" && typeof t.to === "string")
        .map((t) =>
        {
            const id = typeof t.id === "string" && t.id.trim().length > 0
                ? t.id
                : (t.from + "-to-" + t.to);
            return {
                // Port name is the immutable transition id (link key, never
                // changes); the readable "A to B" text is only the display title,
                // so renaming a state can't break existing connections.
                id,
                title: getStateLabel(t.from) + " to " + getStateLabel(t.to),
                transition: {
                    id,
                    from: t.from,
                    to: t.to,
                    frames: sanitizeFrames(t.frames),
                }
            };
        })
        .filter((info) => String(info.id).trim().length > 0);
}

function ensureTrigger(id, title, transition)
{
    const safeId = String(id).trim();
    if (!safeId) return;

    const existing = createdTriggers.get(safeId);
    if (existing)
    {
        existing.transition = transition;
        if (existing.title !== title)
        {
            existing.title = title;
            existing.trigger.setUiAttribs({ "title": title });
        }
        return;
    }

    const trigger = op.inTriggerButton(safeId);
    trigger.setUiAttribs({ "title": title });
    trigger.onTriggered = () =>
    {
        const entry = createdTriggers.get(safeId);
        const t = entry ? entry.transition : null;
        if (!t) return;
        if (pendingTransition) return;
        if (currentActiveStateId !== t.from) return;
        startTransition(t);
    };
    createdTriggers.set(safeId, { trigger, transition, title });
}

function removeTrigger(id)
{
    const entry = createdTriggers.get(id);
    if (!entry) return;
    const t = entry.trigger || entry;
    if (typeof op.removePort === "function") op.removePort(t);
    else if (t && typeof t.remove === "function") t.remove();
    createdTriggers.delete(id);
}

function rebuildTriggers()
{
    parseStoredData();
    updateResetTargets();

    if (pendingTransition)
    {
        const stillValid = parsedData.transitions.some((t) =>
            t
            && String(t.id) === pendingTransition.id
            && String(t.from) === pendingTransition.from
            && String(t.to) === pendingTransition.to
        );
        if (!stillValid) cancelPendingTransition();
    }

    const infos = getTransitionInfos();
    const idSet = new Set(infos.map((i) => i.id));

    Array.from(createdTriggers.keys())
        .filter((id) => !idSet.has(id))
        .forEach(removeTrigger);

    infos.forEach((info) => ensureTrigger(info.id, info.title, info.transition));

    const stillExists = currentActiveStateId
        && parsedData.states.some((s) => s && s.id === currentActiveStateId);
    if (!stillExists)
    {
        const start = parsedData.states.find(
            (s) => s && typeof s.label === "string" && s.label.trim() === "START"
        );
        const fallback = start || parsedData.states[0] || null;
        setActiveStateId(fallback ? fallback.id : null);
    }
    else
    {
        outActiveState.set(getStateLabel(currentActiveStateId));
    }

    syncRegionActivityOutputs();
    refreshInspector();
}

inStoreData.onChange = rebuildTriggers;
rebuildTriggers();

inShow.onTriggered = addmytab;

let konvaContainerId = null;
let konvaState = null;
let konvaTab = null;

exec.onTriggered = () =>
{
    advanceFrame();

    if (CABLES.UI && konvaContainerId && !konvaState)
    {
        const container = document.getElementById(konvaContainerId);
        if (container) konvaState = initKonvaUI(container);
    }
    else if (konvaState && konvaState.layer)
    {
        konvaState.layer.batchDraw();
    }

    next.trigger();
};

function addmytab()
{
    if (!CABLES.UI) return;

    var containerId = "konva-container-" + op.id;
    var tabName = "Automata " + op.id.substring(0, 6);
    var html = '<div id="' + containerId + '" style="width:100%;height:100%;overflow:hidden;"></div>';
    var tab = new CABLES.UI.Tab(tabName, { "icon": "cube", "infotext": "tab_gltf", "padding": false, "singleton": true });

    gui.mainTabs.addTab(tab, true);
    tab.html(html);
    gui.maintabPanel.show(true);

    konvaContainerId = containerId;
    konvaTab = tab;
    konvaState = null;

    const container = document.getElementById(containerId);
    if (container) konvaState = initKonvaUI(container);
}

function initKonvaUI(container)
{
        var width = container.offsetWidth || 800;
        var height = container.offsetHeight || 600;

        const COLORS = {
            nodeFill: "#2f2f2f",
            nodeStroke: "#0e1113",
            nodeStrokeHighlight: "#f6a21a",
            nodeShadow: "rgba(0, 0, 0, 0.35)",
            label: "#eaf7ff",
            transitionCyan: "#28e5ff",
            transitionActive: "#ffd166",
            transitionLabelBg: "rgb(99, 99, 99)",
            transitionLabelBgActive: "rgb(141, 111, 46)",
        };

        const stage = new Konva.Stage({
            container: container,
            width: width,
            height: height,
        });

        const regionLayer = new Konva.Layer();
        stage.add(regionLayer);

        const layer = new Konva.Layer();
        stage.add(layer);

        let nextStateId = 0;
        const states = [];
        const transitions = [];
        const regions = [];
        let nextTransitionId = 0;
        let nextRegionId = 0;
        let activeStateId = null;
        let activeTransitionId = currentActiveTransitionId;

        onActiveStateChanged = (id) =>
        {
            if (activeStateId === id) return;
            activeStateId = id;
            updateObjects();
            layer.batchDraw();
        };

        onTransitionActivityChanged = (id) =>
        {
            activeTransitionId = id;
            updateObjects();
            layer.batchDraw();
        };

        function updateActiveStateOutput()
        {
            setActiveStateId(activeStateId);
        }
        let activeLabelEditor = null;

        function getTransitionLabelText(transition)
        {
            const fromLabel = getStateLabelById(transition.from);
            const toLabel = getStateLabelById(transition.to);
            const frames = sanitizeFrames(transition.frames);
            return fromLabel + " to " + toLabel + " [" + frames + "f]";
        }

        // Load saved data or create default start state
        let savedData = null;
        try
        {
            const stored = inStoreData.get();
            if (stored) savedData = JSON.parse(stored);
        }
        catch (e) { /* ignore parse errors */ }

        if (savedData && Array.isArray(savedData.states) && savedData.states.length > 0)
        {
            if (Array.isArray(savedData.regions))
            {
                savedData.regions.forEach((region) =>
                {
                    if (!region || typeof region.x !== "number" || typeof region.y !== "number") return;
                    const safeRadius = Math.max(0, Number(region.radius) || 0);
                    if (safeRadius <= 0) return;
                    regions.push({
                        id: typeof region.id === "string" && region.id.length > 0
                            ? region.id
                            : "region-" + nextRegionId,
                        x: region.x,
                        y: region.y,
                        radius: safeRadius,
                        title: typeof region.title === "string" && region.title.trim().length > 0
                            ? region.title.trim()
                            : "Region " + (nextRegionId + 1),
                    });
                    nextRegionId += 1;
                });
            }
            savedData.states.forEach((s) =>
            {
                if (s && s.id && typeof s.x === "number" && typeof s.y === "number")
                {
                    states.push({
                        id: String(s.id),
                        label: typeof s.label === "string" ? s.label : String(s.id),
                        x: s.x,
                        y: s.y,
                    });
                }
            });
            if (Array.isArray(savedData.transitions))
            {
                savedData.transitions.forEach((t) =>
                {
                    if (t && t.id && t.from && t.to)
                    {
                        transitions.push({
                            id: String(t.id),
                            from: String(t.from),
                            to: String(t.to),
                            frames: sanitizeFrames(t.frames),
                        });
                    }
                });
            }
            nextStateId = states.length
                ? Math.max(...states.map((s) => parseInt(String(s.id).split("-").pop(), 10) || 0)) + 1
                : 0;
            nextTransitionId = transitions.length
                ? Math.max(...transitions.map((t) => parseInt(String(t.id).split("-").pop(), 10) || 0)) + 1
                : 0;
            nextRegionId = regions.length
                ? Math.max(...regions.map((region) => parseInt(String(region.id).split("-").pop(), 10) || 0)) + 1
                : 0;
            activeStateId = currentActiveStateId && states.some((s) => s.id === currentActiveStateId)
                ? currentActiveStateId
                : (states.length ? states[0].id : null);
            updateActiveStateOutput();
        }
        else
        {
            states.push({
                id: "state-" + nextStateId,
                label: "START",
                x: stage.width() / 2,
                y: stage.height() / 2,
            });
            nextStateId += 1;
            activeStateId = states[0].id;
            updateActiveStateOutput();
        }

        function saveState()
        {
            var snapshot = {
                regions: regions.map((region) => ({
                    id: region.id,
                    x: region.x,
                    y: region.y,
                    radius: region.radius,
                    title: region.title,
                })),
                states: states.map((s) => ({ id: s.id, label: s.label, x: s.x, y: s.y })),
                transitions: transitions.map((t) => ({ id: t.id, from: t.from, to: t.to, frames: sanitizeFrames(t.frames) })),
            };
            inStoreData.set(JSON.stringify(snapshot));
            rebuildTriggers();
        }

        function getStateSnapshot()
        {
            return {
                regions: regions.map((region) => ({ ...region })),
                states: states.map((state) => ({ ...state })),
                transitions: transitions.map((transition) => ({ ...transition })),
            };
        }

        function printStateAsJson()
        {
            const snapshot = getStateSnapshot();
            const json = JSON.stringify(snapshot, null, 2);
            if (navigator && navigator.clipboard && navigator.clipboard.writeText)
            {
                navigator.clipboard
                    .writeText(json)
                    .then(() => { op.log("State JSON copied to clipboard."); })
                    .catch(() => { op.log(json); });
            }
            else
            {
                op.log(json);
            }
        }

        function clearCurrentState()
        {
            regions.forEach((region) =>
            {
                const regionNode = regionLayer.findOne("#" + region.id);
                const regionTitleNode = regionLayer.findOne("#" + region.id + "-title");
                if (regionNode) regionNode.destroy();
                if (regionTitleNode) regionTitleNode.destroy();
            });
            states.forEach((state) =>
            {
                const node = layer.findOne("#" + state.id);
                const label = layer.findOne("#" + state.id + "-label");
                if (node) node.destroy();
                if (label) label.destroy();
            });
            transitions.forEach((transition) =>
            {
                const line = layer.findOne("#" + transition.id);
                const label = layer.findOne("#" + transition.id + "-label");
                if (line) line.destroy();
                if (label) label.destroy();
            });
            regions.length = 0;
            states.length = 0;
            transitions.length = 0;
            pendingTransitionFrom = null;
            tempTransition.visible(false);
        }

        function rebuildStateFromJson(data)
        {
            const incomingStates = Array.isArray(data.states)
                ? data.states
                : Array.isArray(data.targets)
                    ? data.targets
                    : [];
            const incomingTransitions = Array.isArray(data.transitions)
                ? data.transitions
                : Array.isArray(data.connectors)
                    ? data.connectors
                    : [];
            const incomingRegions = Array.isArray(data.regions)
                ? data.regions
                : [];

            clearCurrentState();

            incomingStates.forEach((state) =>
            {
                if (!state || !state.id || typeof state.x !== "number" || typeof state.y !== "number") return;
                const safeState = {
                    id: String(state.id),
                    label: typeof state.label === "string" ? state.label : String(state.id),
                    x: state.x,
                    y: state.y,
                };
                states.push(safeState);
                createState(safeState);
            });

            incomingTransitions.forEach((transition) =>
            {
                if (!transition || !transition.id || !transition.from || !transition.to) return;
                const safeTransition = {
                    id: String(transition.id),
                    from: String(transition.from),
                    to: String(transition.to),
                    frames: sanitizeFrames(transition.frames),
                };
                transitions.push(safeTransition);
                createTransition(safeTransition);
            });

            incomingRegions.forEach((region) =>
            {
                if (!region || typeof region.x !== "number" || typeof region.y !== "number") return;
                const safeRadius = Math.max(0, Number(region.radius) || 0);
                if (safeRadius <= 0) return;
                const safeRegion = {
                    id: typeof region.id === "string" && region.id.length > 0
                        ? region.id
                        : "region-" + nextRegionId,
                    x: region.x,
                    y: region.y,
                    radius: safeRadius,
                    title: typeof region.title === "string" && region.title.trim().length > 0
                        ? region.title.trim()
                        : "Region " + (nextRegionId + 1),
                };
                regions.push(safeRegion);
                createRegion(safeRegion);
                nextRegionId += 1;
            });

            nextStateId = states.length
                ? Math.max(...states.map((s) => parseInt(String(s.id).split("-").pop(), 10) || 0)) + 1
                : 0;
            nextTransitionId = transitions.length
                ? Math.max(...transitions.map((t) => parseInt(String(t.id).split("-").pop(), 10) || 0)) + 1
                : 0;
            nextRegionId = regions.length
                ? Math.max(...regions.map((region) => parseInt(String(region.id).split("-").pop(), 10) || 0)) + 1
                : 0;

            activeStateId = states.length ? states[0].id : null;
            updateActiveStateOutput();
            updateObjects();
            layer.batchDraw();
            saveState();
        }

        function importStateFromClipboard()
        {
            if (!navigator || !navigator.clipboard || !navigator.clipboard.readText)
            {
                op.log("Clipboard API not available.");
                return;
            }
            navigator.clipboard
                .readText()
                .then((text) =>
                {
                    let parsed;
                    try { parsed = JSON.parse(text); }
                    catch (error) { op.log("Invalid JSON in clipboard."); return; }
                    if (!parsed || typeof parsed !== "object")
                    {
                        op.log("Clipboard JSON is not an object.");
                        return;
                    }
                    rebuildStateFromJson(parsed);
                    op.log("State JSON imported from clipboard.");
                })
                .catch(() => { op.log("Failed to read clipboard."); });
        }

        function getStateLabelById(stateId)
        {
            const state = states.find((item) => item.id === stateId);
            return state ? state.label || state.id : stateId;
        }

        function getTransitionPoints(from, to)
        {
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            let angle = Math.atan2(-dy, dx);
            const radius = 55;
            return [
                from.x + -radius * Math.cos(angle + Math.PI),
                from.y + radius * Math.sin(angle + Math.PI),
                to.x + -radius * Math.cos(angle),
                to.y + radius * Math.sin(angle),
            ];
        }

        let pendingTransitionFrom = null;
        let regionDraftStart = null;
        let regionCreationActive = false;
        const MIN_REGION_RADIUS = 8;
        const tempTransition = new Konva.Arrow({
            stroke: COLORS.transitionCyan,
            fill: COLORS.transitionCyan,
            pointerLength: 8,
            pointerWidth: 8,
            dash: [6, 4],
            listening: false,
            visible: false,
        });
        layer.add(tempTransition);

        const regionDraftCircle = new Konva.Circle({
            id: "region-draft",
            fill: "rgba(64, 180, 255, 0.14)",
            stroke: "rgba(64, 180, 255, 0.65)",
            strokeWidth: 2,
            dash: [8, 6],
            radius: 0,
            listening: false,
            visible: false,
        });
        regionLayer.add(regionDraftCircle);

        function updateObjects()
        {
            states.forEach((state) =>
            {
                const node = layer.findOne("#" + state.id);
                const label = layer.findOne("#" + state.id + "-label");
                if (node)
                {
                    const isHighlighted = activeStateId && state.id === activeStateId;
                    const nextStroke = isHighlighted
                        ? COLORS.nodeStrokeHighlight
                        : COLORS.nodeStroke;
                    if (node.getAttr("cachedStroke") !== nextStroke)
                    {
                        node.stroke(nextStroke);
                        node.setAttr("cachedStroke", nextStroke);
                    }
                }
                if (node)
                {
                    node.x(state.x);
                    node.y(state.y);
                }
                if (label)
                {
                    const nextText = state.label || state.id;
                    if (label.getAttr("cachedText") !== nextText)
                    {
                        label.text(nextText);
                        label.setAttr("cachedText", nextText);
                    }
                    label.x(state.x);
                    label.y(state.y);
                    label.offsetX(label.width() / 2);
                    label.offsetY(label.height() / 2);
                }
            });
            syncRegionActivityAppearance();
            transitions.forEach((transition) =>
            {
                const line = layer.findOne("#" + transition.id);
                const label = layer.findOne("#" + transition.id + "-label");
                const labelText = layer.findOne("#" + transition.id + "-label-text");
                const labelBg = layer.findOne("#" + transition.id + "-label-bg");
                const fromNode = layer.findOne("#" + transition.from);
                const toNode = layer.findOne("#" + transition.to);

                if (!fromNode || !toNode) return;

                const points = getTransitionPoints(fromNode.position(), toNode.position());
                line.points(points);
                const isTransitionActive = activeTransitionId && transition.id === activeTransitionId;
                const lineColor = isTransitionActive ? COLORS.transitionActive : COLORS.transitionCyan;
                line.stroke(lineColor);
                line.fill(lineColor);
                if (label && labelText && labelBg)
                {
                    const nextText = getTransitionLabelText(transition);
                    const midX = (points[0] + points[2]) / 2;
                    const midY = (points[1] + points[3]) / 2;
                    label.position({ x: midX, y: midY });
                    labelBg.fill(isTransitionActive ? COLORS.transitionLabelBgActive : COLORS.transitionLabelBg);
                    if (labelText.getAttr("cachedText") !== nextText)
                    {
                        labelText.text(nextText);
                        labelText.setAttr("cachedText", nextText);
                        const textWidth = labelText.width();
                        const textHeight = labelText.height();
                        const bgWidth = textWidth * 1.2;
                        const bgHeight = textHeight * 2;
                        labelBg.size({ width: bgWidth, height: bgHeight });
                        labelText.position({
                            x: (bgWidth - textWidth) / 2,
                            y: (bgHeight - textHeight) / 2,
                        });
                        label.cache();
                    }
                    const rect = label.getClientRect({ relativeTo: layer });
                    label.offsetX(rect.width / 2);
                    label.offsetY(rect.height / 2);
                    label.moveToTop();
                }
            });
            states.forEach((state) =>
            {
                const node = layer.findOne("#" + state.id);
                const label = layer.findOne("#" + state.id + "-label");
                if (node) node.moveToTop();
                if (label) label.moveToTop();
            });
        }

        function getStagePointFromPointer(pointer)
        {
            const scale = stage.scaleX();
            return {
                x: (pointer.x - stage.x()) / scale,
                y: (pointer.y - stage.y()) / scale,
            };
        }

        function updateTempTransition(pointer)
        {
            if (!pendingTransitionFrom || !pointer) return;
            const shape = stage.getIntersection(pointer);
            if (shape && shape.id && shape.id() === pendingTransitionFrom)
            {
                tempTransition.visible(false);
                layer.batchDraw();
                return;
            }
            const fromNode = layer.findOne("#" + pendingTransitionFrom);
            if (!fromNode) return;
            const stagePoint = getStagePointFromPointer(pointer);
            const points = getTransitionPoints(fromNode.position(), stagePoint);
            tempTransition.points(points);
            tempTransition.visible(true);
            tempTransition.moveToTop();
            layer.batchDraw();
        }

        function startEditingStateLabel(state, label)
        {
            if (activeLabelEditor)
            {
                activeLabelEditor.remove();
                activeLabelEditor = null;
            }

            const stageBox = stage.container().getBoundingClientRect();
            const labelPosition = label.getAbsolutePosition();
            const inputWidth = Math.max(label.width(), 100);
            const inputHeight = label.height() + 20;
            const posX = labelPosition.x - inputWidth / 2;
            const posY = labelPosition.y - inputHeight / 2;

            const input = document.createElement("input");
            input.type = "text";
            input.value = state.label || label.text();
            input.style.position = "absolute";
            input.style.top = posY + "px";
            input.style.left = posX + "px";
            input.style.width = inputWidth + "px";
            input.style.height = inputHeight + "px";
            input.style.fontSize = label.fontSize() + "px";
            input.style.fontFamily = label.fontFamily();
            input.style.color = label.fill();
            input.style.background = "rgba(0,0,0,0.6)";
            input.style.border = "1px solid #4aa3ff";
            input.style.padding = "10px";
            input.style.margin = "0";
            input.style.textAlign = "center";
            input.style.outline = "none";
            input.style.boxSizing = "border-box";
            input.style.zIndex = "9999";

            // Append to the Konva container (which has relative positioning via Konva)
            container.style.position = "relative";
            container.appendChild(input);
            input.focus();
            input.select();
            activeLabelEditor = input;

            let committed = false;

            const cleanup = () =>
            {
                if (activeLabelEditor && activeLabelEditor.parentNode)
                {
                    activeLabelEditor.remove();
                }
                activeLabelEditor = null;
            };

            const commit = () =>
            {
                if (committed) return;
                committed = true;
                const newText = input.value.trim();
                state.label = newText ? newText : state.label;
                label.text(state.label || state.id);
                cleanup();
                updateActiveStateOutput();
                updateObjects();
                layer.batchDraw();
                saveState();
            };

            input.addEventListener("keydown", (event) =>
            {
                if (event.key === "Enter")
                {
                    event.preventDefault();
                    commit();
                }
                else if (event.key === "Escape")
                {
                    event.preventDefault();
                    cleanup();
                }
            });

            input.addEventListener("blur", () => { commit(); });
        }

        function startEditingTransitionFrames(transition, label, labelText)
        {
            if (activeLabelEditor)
            {
                activeLabelEditor.remove();
                activeLabelEditor = null;
            }

            const labelPosition = label.getAbsolutePosition();
            const inputWidth = Math.max(labelText.width() + 40, 140);
            const inputHeight = Math.max(labelText.height() + 26, 44);
            const posX = labelPosition.x - inputWidth / 2;
            const posY = labelPosition.y - inputHeight / 2;

            const input = document.createElement("input");
            input.type = "number";
            input.min = "0";
            input.step = "1";
            input.value = String(sanitizeFrames(transition.frames));
            input.style.position = "absolute";
            input.style.top = posY + "px";
            input.style.left = posX + "px";
            input.style.width = inputWidth + "px";
            input.style.height = inputHeight + "px";
            input.style.fontSize = Math.max(labelText.fontSize() + 4, 18) + "px";
            input.style.fontFamily = labelText.fontFamily();
            input.style.color = labelText.fill();
            input.style.background = "rgba(20,20,20,1)";
            input.style.border = "1px solid #4aa3ff";
            input.style.padding = "12px";
            input.style.margin = "0";
            input.style.textAlign = "center";
            input.style.outline = "none";
            input.style.boxSizing = "border-box";
            input.style.zIndex = "9999";

            container.style.position = "relative";
            container.appendChild(input);
            input.focus();
            input.select();
            activeLabelEditor = input;

            let committed = false;

            const cleanup = () =>
            {
                if (activeLabelEditor && activeLabelEditor.parentNode)
                {
                    activeLabelEditor.remove();
                }
                activeLabelEditor = null;
            };

            const commit = () =>
            {
                if (committed) return;
                committed = true;
                transition.frames = sanitizeFrames(input.value);
                cleanup();
                updateObjects();
                layer.batchDraw();
                saveState();
            };

            input.addEventListener("keydown", (event) =>
            {
                if (event.key === "Enter")
                {
                    event.preventDefault();
                    commit();
                }
                else if (event.key === "Escape")
                {
                    event.preventDefault();
                    cleanup();
                }
            });

            input.addEventListener("blur", () => { commit(); });
        }

        function createTransition(transition)
        {
            const line = new Konva.Arrow({
                stroke: COLORS.transitionCyan,
                id: transition.id,
                fill: COLORS.transitionCyan,
                pointerLength: 8,
                pointerWidth: 8,
            });
            layer.add(line);

            const label = new Konva.Group({
                id: transition.id + "-label",
                listening: true,
            });
            const labelBg = new Konva.Rect({
                id: transition.id + "-label-bg",
                fill: COLORS.transitionLabelBg,
                cornerRadius: 8,
                width: 0,
                height: 0,
                listening: true,
            });
            const labelText = new Konva.Text({
                id: transition.id + "-label-text",
                text: getTransitionLabelText(transition),
                fontSize: 12,
                fontFamily: "Arial",
                fill: COLORS.label,
                align: "center",
                listening: true,
            });
            labelText.setAttr("cachedText", getTransitionLabelText(transition));
            const textWidth = labelText.width();
            const textHeight = labelText.height();
            const bgWidth = textWidth * 1.5;
            const bgHeight = textHeight * 2;
            labelBg.size({ width: bgWidth, height: bgHeight });
            labelText.position({
                x: (bgWidth - textWidth) / 2,
                y: (bgHeight - textHeight) / 2,
            });
            label.add(labelBg);
            label.add(labelText);
            layer.add(label);
            const rect = label.getClientRect({ relativeTo: layer });
            label.offsetX(rect.width / 2);
            label.offsetY(rect.height / 2);
            label.cache();

            const handleMouseDown = (event) =>
            {
                if (event.evt.button === 0 && event.evt.ctrlKey)
                {
                    event.evt.preventDefault();
                    event.cancelBubble = true;
                    // Editor force-trigger: run this transition regardless of the
                    // current state — cancel any pending one, jump to its "from"
                    // state, then start it. Only this ctrl+click shortcut behaves
                    // this way; the normal trigger ports stay gated to "from".
                    cancelPendingTransition();
                    if (currentActiveStateId !== transition.from) setActiveStateId(transition.from);
                    startTransition(transition);
                    return;
                }

                if (event.evt.button !== 1 && !(event.evt.button === 0 && event.evt.altKey)) return;
                event.evt.preventDefault();
                removeTransition(transition.id);
            };

            const handleDoubleClick = (event) =>
            {
                event.cancelBubble = true;
                startEditingTransitionFrames(transition, label, labelText);
            };

            labelBg.on("mousedown", handleMouseDown);
            labelText.on("mousedown", handleMouseDown);
            labelBg.on("dblclick", handleDoubleClick);
            labelText.on("dblclick", handleDoubleClick);
        }

        function createRegion(region)
        {
            const title = typeof region.title === "string" && region.title.trim().length > 0
                ? region.title.trim()
                : region.id;

            const circle = new Konva.Circle({
                id: region.id,
                x: region.x,
                y: region.y,
                radius: region.radius,
                fill: REGION_INACTIVE_FILL,
                stroke: REGION_INACTIVE_STROKE,
                strokeWidth: 2,
                listening: true,
            });

            const titleText = new Konva.Text({
                id: region.id + "-title",
                x: region.x,
                y: region.y,
                text: title,
                fontSize: 16,
                fontFamily: "Arial",
                fill: REGION_INACTIVE_TITLE_FILL,
                align: "center",
                listening: true,
            });
            titleText.offsetX(titleText.width() / 2);
            titleText.offsetY(titleText.height() / 2);

            circle.on("dblclick", (event) =>
            {
                event.cancelBubble = true;
                startEditingRegionTitle(region, titleText);
            });

            titleText.on("dblclick", (event) =>
            {
                event.cancelBubble = true;
                startEditingRegionTitle(region, titleText);
            });

            regionLayer.add(circle);
            regionLayer.add(titleText);
            regionLayer.batchDraw();
        }

        function isStateInsideRegion(state, region)
        {
            if (!state || !region) return false;
            const dx = state.x - region.x;
            const dy = state.y - region.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            return distance <= region.radius + STATE_RADIUS;
        }

        function updateRegionAppearance(region, isActive)
        {
            const circle = regionLayer.findOne("#" + region.id);
            const title = regionLayer.findOne("#" + region.id + "-title");

            if (circle)
            {
                circle.fill(isActive ? REGION_ACTIVE_FILL : REGION_INACTIVE_FILL);
                circle.stroke(isActive ? REGION_ACTIVE_STROKE : REGION_INACTIVE_STROKE);
                circle.strokeWidth(isActive ? 3 : 2);
            }

            if (title)
            {
                title.fill(isActive ? REGION_ACTIVE_TITLE_FILL : REGION_INACTIVE_TITLE_FILL);
            }
        }

        // Visual only: the output ports are owned/updated at op scope
        // (see module-level syncRegionActivityOutputs), driven from stored data
        // so they survive reloads without the editor tab being open.
        function syncRegionActivityAppearance()
        {
            const activeState = states.find((state) => state.id === activeStateId) || null;

            regions.forEach((region) =>
            {
                const isActive = !!(activeState && isStateInsideRegion(activeState, region));
                region.active = isActive;
                updateRegionAppearance(region, isActive);
            });

            regionLayer.batchDraw();
        }

        function startEditingRegionTitle(region, label)
        {
            if (activeLabelEditor)
            {
                activeLabelEditor.remove();
                activeLabelEditor = null;
            }

            const labelPosition = label.getAbsolutePosition();
            const inputWidth = Math.max(label.width() + 40, 140);
            const inputHeight = Math.max(label.height() + 24, 42);
            const posX = labelPosition.x - inputWidth / 2;
            const posY = labelPosition.y - inputHeight / 2;

            const input = document.createElement("input");
            input.type = "text";
            input.value = region.title || label.text() || "";
            input.style.position = "absolute";
            input.style.top = posY + "px";
            input.style.left = posX + "px";
            input.style.width = inputWidth + "px";
            input.style.height = inputHeight + "px";
            input.style.fontSize = Math.max(label.fontSize() + 2, 16) + "px";
            input.style.fontFamily = label.fontFamily();
            input.style.color = "#eaf7ff";
            input.style.background = "rgba(20,20,20,0.95)";
            input.style.border = "1px solid #4aa3ff";
            input.style.padding = "10px";
            input.style.margin = "0";
            input.style.textAlign = "center";
            input.style.outline = "none";
            input.style.boxSizing = "border-box";
            input.style.zIndex = "9999";

            container.style.position = "relative";
            container.appendChild(input);
            input.focus();
            input.select();
            activeLabelEditor = input;

            let committed = false;

            const cleanup = () =>
            {
                if (activeLabelEditor && activeLabelEditor.parentNode)
                {
                    activeLabelEditor.remove();
                }
                activeLabelEditor = null;
            };

            const commit = () =>
            {
                if (committed) return;
                committed = true;
                const newTitle = input.value.trim();
                region.title = newTitle || region.title || "Region";
                label.text(region.title);
                label.offsetX(label.width() / 2);
                label.offsetY(label.height() / 2);
                cleanup();
                regionLayer.batchDraw();
                syncRegionActivityAppearance();
                saveState();
            };

            input.addEventListener("keydown", (event) =>
            {
                if (event.key === "Enter")
                {
                    event.preventDefault();
                    commit();
                }
                else if (event.key === "Escape")
                {
                    event.preventDefault();
                    cleanup();
                }
            });

            input.addEventListener("blur", () => { commit(); });
        }

        function removeRegion(regionId)
        {
            const index = regions.findIndex((region) => region.id === regionId);
            if (index === -1) return;

            regions.splice(index, 1);
            const circle = regionLayer.findOne("#" + regionId);
            const title = regionLayer.findOne("#" + regionId + "-title");
            if (circle) circle.destroy();
            if (title) title.destroy();
            regionLayer.batchDraw();
            syncRegionActivityAppearance();
            saveState();
        }

        function getRegionIdFromShapeId(shapeId)
        {
            if (typeof shapeId !== "string" || !shapeId.startsWith("region-")) return null;
            return shapeId.endsWith("-title") ? shapeId.slice(0, -6) : shapeId;
        }

        function isPointNearRegionEdge(region, point, tolerance = 10)
        {
            if (!region || !point) return false;
            const dx = point.x - region.x;
            const dy = point.y - region.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            return Math.abs(distance - region.radius) <= tolerance;
        }

        function updateCursorForPointer(shapeId, stagePoint)
        {
            if (regionResizeTarget)
            {
                container.style.cursor = "nwse-resize";
                return;
            }

            if (regionDragTarget || canvasDrag)
            {
                container.style.cursor = "grabbing";
                return;
            }

            const regionId = getRegionIdFromShapeId(shapeId);
            if (shapeId && shapeId.endsWith("-title") && regionId)
            {
                container.style.cursor = "grab";
                return;
            }

            if (shapeId === regionId && regionId)
            {
                const regionObj = regions.find((region) => region.id === regionId);
                if (regionObj && isPointNearRegionEdge(regionObj, stagePoint))
                {
                    container.style.cursor = "nwse-resize";
                    return;
                }
            }

            container.style.cursor = "default";
        }

        function removeTransition(transitionId, skipUpdate)
        {
            const index = transitions.findIndex((transition) => transition.id === transitionId);
            if (index === -1) return;

            if (pendingTransition && pendingTransition.id === transitionId)
            {
                cancelPendingTransition();
            }

            transitions.splice(index, 1);
            const line = layer.findOne("#" + transitionId);
            const label = layer.findOne("#" + transitionId + "-label");
            if (line) line.destroy();
            if (label) label.destroy();
            if (!skipUpdate)
            {
                updateObjects();
                layer.batchDraw();
                saveState();
            }
        }

        function transitionExists(fromId, toId)
        {
            return transitions.some((transition) => transition.from === fromId && transition.to === toId);
        }

        function addTransition(fromId, toId)
        {
            if (fromId === toId) return;
            if (transitionExists(fromId, toId)) return;
            const transition = {
                id: "transition-" + nextTransitionId,
                from: fromId,
                to: toId,
                frames: 0,
            };
            nextTransitionId += 1;
            transitions.push(transition);
            createTransition(transition);
            updateObjects();
            layer.batchDraw();
            saveState();
        }

        regions.forEach((region) => { createRegion(region); });
        transitions.forEach((transition) => { createTransition(transition); });

        function removeState(stateId)
        {
            if (states.length <= 1) return;
            const index = states.findIndex((state) => state.id === stateId);
            if (index === -1) return;

            if (pendingTransitionFrom === stateId)
            {
                pendingTransitionFrom = null;
                tempTransition.visible(false);
            }

            if (pendingTransition && (pendingTransition.from === stateId || pendingTransition.to === stateId))
            {
                cancelPendingTransition();
            }

            states.splice(index, 1);
            const node = layer.findOne("#" + stateId);
            const label = layer.findOne("#" + stateId + "-label");
            if (node) node.destroy();
            if (label) label.destroy();

            const related = transitions.filter(
                (transition) => transition.from === stateId || transition.to === stateId
            );
            related.forEach((transition) => { removeTransition(transition.id, true); });

            if (activeStateId === stateId)
            {
                activeStateId = states.length ? states[0].id : null;
                updateActiveStateOutput();
            }
            updateObjects();
            layer.batchDraw();
            saveState();
        }

        function createState(state)
        {
            const isHighlighted = state.id === activeStateId;
            const node = new Konva.Circle({
                id: state.id,
                fill: COLORS.nodeFill,
                stroke: isHighlighted ? COLORS.nodeStrokeHighlight : COLORS.nodeStroke,
                strokeWidth: 4,
                radius: STATE_RADIUS,
                shadowBlur: 12,
                shadowColor: COLORS.nodeShadow,
                shadowForStrokeEnabled: false,
            });
            node.setAttr("cachedStroke", node.stroke());
            layer.add(node);

            const label = new Konva.Text({
                id: state.id + "-label",
                text: state.label || state.id,
                fontSize: 14,
                fontFamily: "Arial",
                fill: COLORS.label,
                align: "center",
                listening: false,
            });
            label.setAttr("cachedText", label.text());
            label.offsetX(label.width() / 2);
            label.offsetY(label.height() / 2);
            layer.add(label);

            node.on("contextmenu", (event) =>
            {
                event.evt.preventDefault();
                if (event.evt.ctrlKey) return;
                pendingTransitionFrom = state.id;
                updateTempTransition(stage.getPointerPosition());
            });

            node.on("dblclick", (event) =>
            {
                event.cancelBubble = true;
                startEditingStateLabel(state, label);
            });
        }

        function addStateAt(x, y)
        {
            const state = {
                id: "state-" + nextStateId,
                label: "state-" + nextStateId,
                x: x,
                y: y,
            };
            nextStateId += 1;
            states.push(state);
            createState(state);
            updateObjects();
            layer.batchDraw();
            saveState();
        }

        states.forEach((state) => { createState(state); });

        updateObjects();

        // Manual drag tracking (Konva's built-in drag doesn't work inside cables tabs)
        let dragTarget = null; // { stateObj, node, label, offsetX, offsetY }
        let regionDragTarget = null; // { regionObj, circle, title, offsetX, offsetY }
        let regionResizeTarget = null; // { regionObj, circle }
        let canvasDrag = false;
        let canvasDragStart = null;

        stage.on("mousedown", (e) =>
        {
            const pointer = stage.getPointerPosition();
            if (!pointer) return;
            const stagePoint = getStagePointFromPointer(pointer);
            const shape = stage.getIntersection(pointer);
            const shapeId = shape && shape.id ? shape.id() : null;
            const regionId = getRegionIdFromShapeId(shapeId);

            // Middle-click: delete state or transition
            if (e.evt.button === 1)
            {
                e.evt.preventDefault();
                if (shape && shape.id)
                {
                    const id = shapeId;
                    if (id.startsWith("state-")) removeState(id);
                    else if (id.startsWith("transition-")) removeTransition(id);
                }
                return;
            }

            // Left-click
            if (e.evt.button === 0)
            {
                if (shapeId && shapeId.startsWith("state-") && e.evt.altKey)
                {
                    e.evt.preventDefault();
                    removeState(shapeId);
                    return;
                }

                if (shapeId && shapeId.startsWith("transition-") && e.evt.altKey)
                {
                    e.evt.preventDefault();
                    removeTransition(shapeId);
                    return;
                }

                if (regionId && e.evt.altKey)
                {
                    e.evt.preventDefault();
                    removeRegion(regionId);
                    return;
                }

                if (shapeId === regionId && regionId)
                {
                    const regionObj = regions.find((region) => region.id === regionId);
                    if (regionObj && isPointNearRegionEdge(regionObj, stagePoint))
                    {
                        regionResizeTarget = {
                            regionObj: regionObj,
                            circle: regionLayer.findOne("#" + regionId),
                        };
                        container.style.cursor = "nwse-resize";
                        return;
                    }
                }

                // Alt+click on state: set active
                if (shapeId && shapeId.startsWith("state-") && e.evt.ctrlKey)
                {
                    activeStateId = shapeId;
                    updateActiveStateOutput();
                    updateObjects();
                    layer.batchDraw();
                    saveState();
                    return;
                }

                // Pending transition: complete it
                if (pendingTransitionFrom)
                {
                    if (shapeId && shapeId.startsWith("state-"))
                    {
                        const fromId = pendingTransitionFrom;
                        pendingTransitionFrom = null;
                        tempTransition.visible(false);
                        addTransition(fromId, shapeId);
                    }
                    else
                    {
                        pendingTransitionFrom = null;
                        tempTransition.visible(false);
                        layer.batchDraw();
                    }
                    return;
                }

                // Drag a region by dragging its title text
                if (shapeId && shapeId.endsWith("-title") && regionId)
                {
                    const regionObj = regions.find((region) => region.id === regionId);
                    if (regionObj)
                    {
                        regionDragTarget = {
                            regionObj: regionObj,
                            circle: regionLayer.findOne("#" + regionId),
                            title: regionLayer.findOne("#" + regionId + "-title"),
                            offsetX: stagePoint.x - regionObj.x,
                            offsetY: stagePoint.y - regionObj.y,
                        };
                        container.style.cursor = "grabbing";
                    }
                    return;
                }

                // Start dragging a state node
                if (shapeId && shapeId.startsWith("state-"))
                {
                    const stateObj = states.find((s) => s.id === shapeId);
                    if (stateObj)
                    {
                        const node = layer.findOne("#" + stateObj.id);
                        const label = layer.findOne("#" + stateObj.id + "-label");
                        dragTarget = {
                            stateObj: stateObj,
                            node: node,
                            label: label,
                            offsetX: stagePoint.x - stateObj.x,
                            offsetY: stagePoint.y - stateObj.y,
                        };
                        if (node) node.moveToTop();
                        if (label) label.moveToTop();
                        layer.batchDraw();
                    }
                    return;
                }

                if (!shape && !e.evt.altKey && !e.evt.ctrlKey && !e.evt.metaKey && !e.evt.shiftKey)
                {
                    regionDraftStart = { x: stagePoint.x, y: stagePoint.y };
                    regionCreationActive = true;
                    regionDraftCircle.position(regionDraftStart);
                    regionDraftCircle.radius(0);
                    regionDraftCircle.visible(true);
                    regionLayer.batchDraw();
                    return;
                }
            }

            // Right-click on empty canvas: start canvas pan
            if (e.evt.button === 2)
            {
                if (shape && shape instanceof Konva.Circle) return;
                canvasDrag = true;
                canvasDragStart = { x: e.evt.clientX - stage.x(), y: e.evt.clientY - stage.y() };
                container.style.cursor = "grabbing";
            }
        });

        stage.on("mousemove", (e) =>
        {
            const pointer = stage.getPointerPosition();
            if (!pointer) return;
            const stagePoint = getStagePointFromPointer(pointer);
            const shape = stage.getIntersection(pointer);
            const shapeId = shape && shape.id ? shape.id() : null;

            updateCursorForPointer(shapeId, stagePoint);

            if (regionCreationActive && regionDraftStart)
            {
                const dx = stagePoint.x - regionDraftStart.x;
                const dy = stagePoint.y - regionDraftStart.y;
                const radius = Math.sqrt(dx * dx + dy * dy);
                regionDraftCircle.radius(radius);
                regionLayer.batchDraw();
                return;
            }

            if (regionResizeTarget)
            {
                const dx = stagePoint.x - regionResizeTarget.regionObj.x;
                const dy = stagePoint.y - regionResizeTarget.regionObj.y;
                const radius = Math.max(MIN_REGION_RADIUS, Math.sqrt(dx * dx + dy * dy));
                regionResizeTarget.regionObj.radius = radius;
                if (regionResizeTarget.circle) regionResizeTarget.circle.radius(radius);
                    syncRegionActivityAppearance();
                container.style.cursor = "nwse-resize";
                return;
            }

            if (regionDragTarget)
            {
                const nextX = stagePoint.x - regionDragTarget.offsetX;
                const nextY = stagePoint.y - regionDragTarget.offsetY;
                regionDragTarget.regionObj.x = nextX;
                regionDragTarget.regionObj.y = nextY;

                if (regionDragTarget.circle)
                {
                    regionDragTarget.circle.x(nextX);
                    regionDragTarget.circle.y(nextY);
                }
                if (regionDragTarget.title)
                {
                    regionDragTarget.title.x(nextX);
                    regionDragTarget.title.y(nextY);
                }

                    syncRegionActivityAppearance();
                container.style.cursor = "grabbing";
                return;
            }

            // Dragging a state node
            if (dragTarget)
            {
                dragTarget.stateObj.x = stagePoint.x - dragTarget.offsetX;
                dragTarget.stateObj.y = stagePoint.y - dragTarget.offsetY;
                updateObjects();
                layer.batchDraw();
                return;
            }

            // Panning the canvas
            if (canvasDrag && canvasDragStart)
            {
                stage.position({
                    x: e.evt.clientX - canvasDragStart.x,
                    y: e.evt.clientY - canvasDragStart.y,
                });
                stage.batchDraw();
                return;
            }

            // Update temp transition arrow
            if (pendingTransitionFrom)
            {
                updateTempTransition(pointer);
            }
        });

        stage.on("mouseup", () =>
        {
            let didCreateRegion = false;

            if (regionCreationActive && regionDraftStart)
            {
                const pointer = stage.getPointerPosition();
                const stagePoint = pointer
                    ? getStagePointFromPointer(pointer)
                    : regionDraftStart;
                const dx = stagePoint.x - regionDraftStart.x;
                const dy = stagePoint.y - regionDraftStart.y;
                const radius = Math.sqrt(dx * dx + dy * dy);

                if (radius >= MIN_REGION_RADIUS)
                {
                    const region = {
                        id: "region-" + nextRegionId,
                        x: regionDraftStart.x,
                        y: regionDraftStart.y,
                        radius: radius,
                        title: "Region " + (nextRegionId + 1),
                    };
                    nextRegionId += 1;
                    regions.push(region);
                    createRegion(region);
                    syncRegionActivityAppearance();
                    didCreateRegion = true;
                }

                regionDraftStart = null;
                regionCreationActive = false;
                regionDraftCircle.visible(false);
                regionDraftCircle.radius(0);
                syncRegionActivityAppearance();
            }

            if (dragTarget) saveState();
            if (regionDragTarget) saveState();
            if (regionResizeTarget) saveState();
            if (didCreateRegion) saveState();
            dragTarget = null;
            regionDragTarget = null;
            regionResizeTarget = null;
            canvasDrag = false;
            canvasDragStart = null;
            container.style.cursor = "default";
        });

        stage.on("dblclick", (e) =>
        {
            // Dblclick on state node: edit label
            if (e.target !== stage && e.target.id && e.target.id().startsWith("state-"))
            {
                return; // handled by node's dblclick
            }
            // Dblclick on empty canvas: add state
            if (e.target === stage)
            {
                const pointer = stage.getPointerPosition();
                if (!pointer) return;
                const scale = stage.scaleX();
                const x = (pointer.x - stage.x()) / scale;
                const y = (pointer.y - stage.y()) / scale;
                addStateAt(x, y);
            }
        });

        const scaleBy = 1.05;
        stage.on("wheel", (e) =>
        {
            e.evt.preventDefault();
            const oldScale = stage.scaleX();
            const pointer = stage.getPointerPosition();
            if (!pointer) return;

            const mousePointTo = {
                x: (pointer.x - stage.x()) / oldScale,
                y: (pointer.y - stage.y()) / oldScale,
            };

            let direction = e.evt.deltaY > 0 ? 1 : -1;
            if (e.evt.ctrlKey) direction = -direction;

            const newScale = direction > 0 ? oldScale * scaleBy : oldScale / scaleBy;
            stage.scale({ x: newScale, y: newScale });

            const newPos = {
                x: pointer.x - mousePointTo.x * newScale,
                y: pointer.y - mousePointTo.y * newScale,
            };
            stage.position(newPos);
            stage.batchDraw();
        });

        container.addEventListener("contextmenu", (e) => { e.preventDefault(); });

        // Stop cables UI from intercepting mouse events (bubble phase)
        // Leave a safety margin on the right edge so the tab resize handle still works
        const RESIZE_SAFETY_MARGIN = 32;
        ["mousedown", "mousemove", "mouseup", "pointerdown", "pointermove", "pointerup"].forEach((evtName) =>
        {
            container.addEventListener(evtName, (e) =>
            {
                const rect = container.getBoundingClientRect();
                if (e.clientX >= rect.right - RESIZE_SAFETY_MARGIN) return;
                e.stopPropagation();
            });
        });

        container.addEventListener("mouseleave", () =>
        {
            dragTarget = null;
            regionDragTarget = null;
            regionResizeTarget = null;
            canvasDrag = false;
            canvasDragStart = null;
            container.style.cursor = "default";
        });

        // Resize the Konva stage when the tab/container is resized
        const resizeObserver = new ResizeObserver(() =>
        {
            const newWidth = container.offsetWidth || 800;
            const newHeight = container.offsetHeight || 600;
            stage.width(newWidth);
            stage.height(newHeight);
            stage.batchDraw();
        });
        resizeObserver.observe(container);

        return { stage: stage, layer: layer, resizeObserver: resizeObserver };
}