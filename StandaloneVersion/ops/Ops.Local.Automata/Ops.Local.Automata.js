// welcome to your new op!
// have a look at the documentation:
// https://cables.gl/docs/5_writing_ops/dev_ops/dev_ops

const konvaModule = op.require("konva");
const Konva = konvaModule.default || konvaModule;

const
    exec = op.inTrigger("Trigger"),
    myNumber = op.inFloat("Number"),
    next = op.outTrigger("Next"),
    inShow = op.inTriggerButton("Show Tab"),
    inStoreData = op.inString("Stored Automata Data", ""),
    result = op.outNumber("Result"),
    outActiveState = op.outString("Active State");

inStoreData.setUiAttribs({ "hidePort": true, "greyout": true });

inShow.onTriggered = addmytab;



exec.onTriggered = () =>
{
    result.set(myNumber.get() * 100);
};

function addmytab()
{
if(CABLES.UI)
{
    var tab;
    var containerId = "konva-container-" + op.id;
    var tabName = "Automata " + op.id.substring(0, 6);
    var html = '<div id="' + containerId + '" style="width:100%;height:100%;overflow:hidden;"></div>';
    tab = new CABLES.UI.Tab(tabName, { "icon": "cube", "infotext": "tab_gltf", "padding": false, "singleton": true });

    gui.mainTabs.addTab(tab, true);

    tab.html(html);

    gui.maintabPanel.show(true);

    requestAnimationFrame(() =>
    {
        var container = document.getElementById(containerId);
        if (!container)
        {
            op.log("konva-container not found in DOM");
            return;
        }

        var width = container.offsetWidth || 800;
        var height = container.offsetHeight || 600;

        const COLORS = {
            nodeFill: "#2f2f2f",
            nodeStroke: "#0e1113",
            nodeStrokeHighlight: "#f6a21a",
            nodeShadow: "rgba(0, 0, 0, 0.35)",
            label: "#eaf7ff",
            transitionCyan: "#28e5ff",
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

        function updateActiveStateOutput()
        {
            const s = states.find((item) => item.id === activeStateId);
            outActiveState.set(s ? (s.label || s.id) : "");
        }
        let activeLabelEditor = null;

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
            activeStateId = states.length ? states[0].id : null;
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
                transitions: transitions.map((t) => ({ id: t.id, from: t.from, to: t.to })),
            };
            inStoreData.set(JSON.stringify(snapshot));
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
                if (label && labelText && labelBg)
                {
                    const nextText = getStateLabelById(transition.from) + " to " + getStateLabelById(transition.to);
                    const midX = (points[0] + points[2]) / 2;
                    const midY = (points[1] + points[3]) / 2;
                    label.position({ x: midX, y: midY });
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
                fill: "rgb(99, 99, 99)",
                cornerRadius: 8,
                width: 0,
                height: 0,
                listening: true,
            });
            const labelText = new Konva.Text({
                id: transition.id + "-label-text",
                text: getStateLabelById(transition.from) + " to " + getStateLabelById(transition.to),
                fontSize: 12,
                fontFamily: "Arial",
                fill: COLORS.label,
                align: "center",
                listening: true,
            });
            labelText.setAttr("cachedText", getStateLabelById(transition.from) + " to " + getStateLabelById(transition.to));
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

            const handleMiddleClick = (event) =>
            {
                if (event.evt.button !== 1) return;
                event.evt.preventDefault();
                removeTransition(transition.id);
            };

            labelBg.on("mousedown", handleMiddleClick);
            labelText.on("mousedown", handleMiddleClick);
        }

        function removeTransition(transitionId, skipUpdate)
        {
            const index = transitions.findIndex((transition) => transition.id === transitionId);
            if (index === -1) return;
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
    });
}

}