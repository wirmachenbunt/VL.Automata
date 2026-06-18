// welcome to your new op!
// have a look at the documentation:
// https://cables.gl/docs/5_writing_ops/dev_ops/dev_ops

const konvaModule = op.require("konva");
const Konva = konvaModule.default || konvaModule;

const
    inStoreData = op.inString("Stored Automata Data", ""),
    exec = op.inTrigger("Trigger"),
    next = op.outTrigger("Next"),
    inShow = op.inTriggerButton("Show Tab"),
    resetTargetIn = op.inDropDown("Reset Target", [""], ""),
    resetIn = op.inTriggerButton("Reset"),
    frameCountIn = op.inInt("Frame Count", 60),
    outActiveState = op.outString("Active State"),
    frameCounterOut = op.outNumber("State Frames"),
    outTransitionCountdownOut = op.outNumber("Transition Countdown"),
    outStates = op.outArray("States");

inStoreData.setUiAttribs({ "hidePort": true, "greyout": true });
inShow.setUiAttribs({ "hidePort": true });

// --- Dynamic transition triggers (driven by inStoreData) ---
const createdTriggers = new Map();
let parsedData = { states: [], transitions: [] };
let currentActiveStateId = null;
let onActiveStateChanged = null;
let lastStateChangeAt = performance.now();
let resetTargets = [];
let currentActiveTransitionId = null;
let onTransitionActivityChanged = null;
let pendingTransition = null;

function sanitizeFrames(value)
{
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function getNormalizedTransitionCountdown()
{
    if (!pendingTransition || pendingTransition.frames <= 0) return 0;

    const elapsedFrames = (performance.now() - pendingTransition.startedAt) / (1000 / 60);
    const remainingFrames = Math.max(pendingTransition.frames - elapsedFrames, 0);
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
        startedAt: performance.now(),
    };
    setActiveTransitionId(transition.id);
    updateTransitionCountdownOutput();
}

function processPendingTransition()
{
    if (!pendingTransition) return;

    const elapsedFrames = Math.floor((performance.now() - pendingTransition.startedAt) / (1000 / 60));
    if (elapsedFrames < pendingTransition.frames) return;

    const nextStateId = pendingTransition.to;
    pendingTransition = null;
    setActiveTransitionId(null);
    setActiveStateId(nextStateId);
}

function updateFrameCounterOutput()
{
    frameCounterOut.set(framesSinceStateChange());
}

function framesSinceStateChange()
{
    return Math.floor((performance.now() - lastStateChangeAt) / (1000 / 60));
}

op.onFrame = () =>
{
    updateFrameCounterOutput();
    updateTransitionCountdownOutput();
    processPendingTransition();
};

setInterval(() =>
{
    updateFrameCounterOutput();
    updateTransitionCountdownOutput();
    processPendingTransition();
}, 16);

function parseStoredData()
{
    try
    {
        const stored = inStoreData.get();
        const data = stored ? JSON.parse(stored) : null;
        parsedData = {
            states: data && Array.isArray(data.states) ? data.states : [],
            transitions: data && Array.isArray(data.transitions) ? data.transitions : [],
        };
    }
    catch (e)
    {
        parsedData = { states: [], transitions: [] };
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

    const values = resetTargets.length
        ? resetTargets.map((target) => target.label)
        : [""];
    const selectedLabel = typeof resetTargetIn.value === "string" ? resetTargetIn.value : "";
    const selectedExists = values.includes(selectedLabel);
    const startTarget = resetTargets.find((target) =>
    {
        const state = parsedData.states.find((item) => item && item.id === target.id);
        return state && typeof state.label === "string" && state.label.trim() === "START";
    });
    const fallbackLabel = startTarget
        ? startTarget.label
        : (resetTargets[0] ? resetTargets[0].label : "");

    resetTargetIn.setUiAttribs({ "values": values });
    resetTargetIn.set(selectedExists ? selectedLabel : fallbackLabel);
    outStates.set(values);
}

function getResetTargetId()
{
    const selectedLabel = resetTargetIn.get();
    const target = resetTargets.find((item) => item.label === selectedLabel);
    return target ? target.id : null;
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
    lastStateChangeAt = performance.now();
    updateFrameCounterOutput();
    outActiveState.set(id ? getStateLabel(id) : "");
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
            const name = getStateLabel(t.from) + " to " + getStateLabel(t.to);
            return {
                name,
                transition: {
                    id: typeof t.id === "string" ? t.id : (t.from + "-to-" + t.to),
                    from: t.from,
                    to: t.to,
                    frames: sanitizeFrames(t.frames),
                }
            };
        })
        .filter((info) => info.name.trim().length > 0);
}

function ensureTrigger(name, transition)
{
    const safeName = String(name).trim();
    if (!safeName) return;
    if (createdTriggers.has(safeName))
    {
        createdTriggers.get(safeName).transition = transition;
        return;
    }
    const trigger = op.inTriggerButton(safeName);
    trigger.onTriggered = () =>
    {
        const entry = createdTriggers.get(safeName);
        const t = entry ? entry.transition : null;
        if (!t) return;
        if (pendingTransition) return;
        if (currentActiveStateId !== t.from) return;
        startTransition(t);
    };
    createdTriggers.set(safeName, { trigger, transition });
}

function removeTrigger(name)
{
    const entry = createdTriggers.get(name);
    if (!entry) return;
    const t = entry.trigger || entry;
    if (typeof op.removePort === "function") op.removePort(t);
    else if (t && typeof t.remove === "function") t.remove();
    createdTriggers.delete(name);
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
    const nameSet = new Set(infos.map((i) => i.name));

    Array.from(createdTriggers.keys())
        .filter((n) => !nameSet.has(n))
        .forEach(removeTrigger);

    infos.forEach((info) => ensureTrigger(info.name, info.transition));

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

    refreshInspector();
}

inStoreData.onChange = rebuildTriggers;
rebuildTriggers();

inShow.onTriggered = addmytab;

let konvaContainerId = null;
let konvaState = null;

exec.onTriggered = () =>
{
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

        const layer = new Konva.Layer();
        stage.add(layer);

        let nextStateId = 0;
        const states = [];
        const transitions = [];
        let nextTransitionId = 0;
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
                states: states.map((s) => ({ id: s.id, label: s.label, x: s.x, y: s.y })),
                transitions: transitions.map((t) => ({ id: t.id, from: t.from, to: t.to, frames: sanitizeFrames(t.frames) })),
            };
            inStoreData.set(JSON.stringify(snapshot));
            rebuildTriggers();
        }

        function getStateSnapshot()
        {
            return {
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

            nextStateId = states.length
                ? Math.max(...states.map((s) => parseInt(String(s.id).split("-").pop(), 10) || 0)) + 1
                : 0;
            nextTransitionId = transitions.length
                ? Math.max(...transitions.map((t) => parseInt(String(t.id).split("-").pop(), 10) || 0)) + 1
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
                    if (!pendingTransition && currentActiveStateId === transition.from)
                    {
                        startTransition(transition);
                    }
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
                radius: 50,
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
        let canvasDrag = false;
        let canvasDragStart = null;

        stage.on("mousedown", (e) =>
        {
            const pointer = stage.getPointerPosition();
            if (!pointer) return;
            const stagePoint = getStagePointFromPointer(pointer);
            const shape = stage.getIntersection(pointer);

            // Middle-click: delete state or transition
            if (e.evt.button === 1)
            {
                e.evt.preventDefault();
                if (shape && shape.id)
                {
                    const id = shape.id();
                    if (id.startsWith("state-")) removeState(id);
                    else if (id.startsWith("transition-")) removeTransition(id);
                }
                return;
            }

            // Left-click
            if (e.evt.button === 0)
            {
                if (shape && shape.id && shape.id().startsWith("state-") && e.evt.altKey)
                {
                    e.evt.preventDefault();
                    removeState(shape.id());
                    return;
                }

                if (shape && shape.id && shape.id().startsWith("transition-") && e.evt.altKey)
                {
                    e.evt.preventDefault();
                    removeTransition(shape.id());
                    return;
                }

                // Alt+click on state: set active
                if (shape && shape.id && shape.id().startsWith("state-") && e.evt.ctrlKey)
                {
                    activeStateId = shape.id();
                    updateActiveStateOutput();
                    updateObjects();
                    layer.batchDraw();
                    saveState();
                    return;
                }

                // Pending transition: complete it
                if (pendingTransitionFrom)
                {
                    if (shape && shape.id && shape.id().startsWith("state-"))
                    {
                        const fromId = pendingTransitionFrom;
                        pendingTransitionFrom = null;
                        tempTransition.visible(false);
                        addTransition(fromId, shape.id());
                    }
                    else
                    {
                        pendingTransitionFrom = null;
                        tempTransition.visible(false);
                        layer.batchDraw();
                    }
                    return;
                }

                // Start dragging a state node
                if (shape && shape.id && shape.id().startsWith("state-"))
                {
                    const stateObj = states.find((s) => s.id === shape.id());
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
            }

            // Right-click on empty canvas: start canvas pan
            if (e.evt.button === 2)
            {
                if (shape && shape instanceof Konva.Circle) return;
                canvasDrag = true;
                canvasDragStart = { x: e.evt.clientX - stage.x(), y: e.evt.clientY - stage.y() };
            }
        });

        stage.on("mousemove", (e) =>
        {
            const pointer = stage.getPointerPosition();
            if (!pointer) return;

            // Dragging a state node
            if (dragTarget)
            {
                const stagePoint = getStagePointFromPointer(pointer);
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
            if (dragTarget) saveState();
            dragTarget = null;
            canvasDrag = false;
            canvasDragStart = null;
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
            canvasDrag = false;
            canvasDragStart = null;
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

        return { stage: stage, layer: layer };
}