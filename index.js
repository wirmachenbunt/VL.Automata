document.addEventListener('DOMContentLoaded', () => {
  if (!window.Konva) {
    console.error('Konva not loaded. Check the CDN script tag.');
    return;
  }

  const width = window.innerWidth;
  const height = window.innerHeight;

  const COLORS = {
    nodeFill: '#2f2f2f',
    nodeStroke: '#0e1113',
    nodeStrokeHighlight: '#f6a21a',
    nodeShadow: 'rgba(0, 0, 0, 0.35)',
    label: '#eaf7ff',
    transitionCyan: '#28e5ff',
  };

  const stage = new Konva.Stage({
    container: 'container',
    width: width,
    height: height,
  });

  const layer = new Konva.Layer();
  stage.add(layer);

  let nextStateId = 0;
  const states = [
    {
      id: 'state-' + nextStateId,
      label: 'state-' + nextStateId,
      x: stage.width() / 2,
      y: stage.height() / 2,
    },
  ];
  nextStateId += 1;
  let activeStateId = states[0].id;
  let activeLabelEditor = null;

  function printStateAsJson() {
    const snapshot = {
      states: states.map((state) => ({ ...state })),
      transitions: transitions.map((transition) => ({ ...transition })),
    };
    const json = JSON.stringify(snapshot, null, 2);
    if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(json)
        .then(() => {
          console.log('State JSON copied to clipboard.');
        })
        .catch(() => {
          console.log(json);
        });
    } else {
      console.log(json);
    }
  }

  function clearCurrentState() {
    states.forEach((state) => {
      const node = layer.findOne('#' + state.id);
      const label = layer.findOne('#' + state.id + '-label');
      if (node) {
        node.destroy();
      }
      if (label) {
        label.destroy();
      }
    });
    transitions.forEach((transition) => {
      const line = layer.findOne('#' + transition.id);
      const label = layer.findOne('#' + transition.id + '-label');
      if (line) {
        line.destroy();
      }
      if (label) {
        label.destroy();
      }
    });
    states.length = 0;
    transitions.length = 0;
    pendingTransitionFrom = null;
    tempTransition.visible(false);
  }

  function rebuildStateFromJson(data) {
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

    incomingStates.forEach((state) => {
      if (!state || !state.id || typeof state.x !== 'number' || typeof state.y !== 'number') {
        return;
      }
      const safeState = {
        id: String(state.id),
        label: typeof state.label === 'string' ? state.label : String(state.id),
        x: state.x,
        y: state.y,
      };
      states.push(safeState);
      createState(safeState);
    });

    incomingTransitions.forEach((transition) => {
      if (!transition || !transition.id || !transition.from || !transition.to) {
        return;
      }
      const safeTransition = {
        id: String(transition.id),
        from: String(transition.from),
        to: String(transition.to),
      };
      transitions.push(safeTransition);
      createTransition(safeTransition);
    });

    nextStateId = states.length
      ? Math.max(...states.map((s) => parseInt(String(s.id).split('-').pop(), 10) || 0)) + 1
      : 0;
    nextTransitionId = transitions.length
      ? Math.max(...transitions.map((t) => parseInt(String(t.id).split('-').pop(), 10) || 0)) + 1
      : 0;

    activeStateId = states.length ? states[0].id : null;
    updateObjects();
    layer.batchDraw();
  }

  function importStateFromClipboard() {
    if (!navigator || !navigator.clipboard || !navigator.clipboard.readText) {
      console.log('Clipboard API not available.');
      return;
    }
    navigator.clipboard
      .readText()
      .then((text) => {
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (error) {
          console.log('Invalid JSON in clipboard.');
          return;
        }
        if (!parsed || typeof parsed !== 'object') {
          console.log('Clipboard JSON is not an object.');
          return;
        }
        rebuildStateFromJson(parsed);
        console.log('State JSON imported from clipboard.');
      })
      .catch(() => {
        console.log('Failed to read clipboard.');
      });
  }

  const copyStateButton = document.getElementById('copy-state');
  if (copyStateButton) {
    copyStateButton.addEventListener('click', () => {
      printStateAsJson();
    });
  }

  const importStateButton = document.getElementById('import-state');
  if (importStateButton) {
    importStateButton.addEventListener('click', () => {
      importStateFromClipboard();
    });
  }

  

  function getStateLabelById(stateId) {
    const state = states.find((item) => item.id === stateId);
    return state ? state.label || state.id : stateId;
  }


function getTransitionPoints(from, to) {
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

  const transitions = [];
  let nextTransitionId = 0;
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

// update all objects on the canvas from the state of the app
  function updateObjects() {
    states.forEach((state) => {
      const node = layer.findOne('#' + state.id);
      const label = layer.findOne('#' + state.id + '-label');
      if (node) {
        const isHighlighted = activeStateId && state.id === activeStateId;
        node.stroke(
          isHighlighted ? COLORS.nodeStrokeHighlight : COLORS.nodeStroke
        );
      }
      node.x(state.x);
      node.y(state.y);
      if (label) {
        label.text(state.label || state.id);
        label.x(state.x);
        label.y(state.y);
        label.offsetX(label.width() / 2);
        label.offsetY(label.height() / 2);
      }
    });
    transitions.forEach((transition) => {
      const line = layer.findOne('#' + transition.id);
      const label = layer.findOne('#' + transition.id + '-label');
      const labelText = layer.findOne('#' + transition.id + '-label-text');
      const labelBg = layer.findOne('#' + transition.id + '-label-bg');
      const fromNode = layer.findOne('#' + transition.from);
      const toNode = layer.findOne('#' + transition.to);

      if (!fromNode || !toNode) {
        return;
      }

      const points = getTransitionPoints(
        fromNode.position(),
        toNode.position()
      );
      line.points(points);
      if (label && labelText && labelBg) {
        labelText.text(
          `${getStateLabelById(transition.from)} to ${getStateLabelById(transition.to)}`
        );
        const midX = (points[0] + points[2]) / 2;
        const midY = (points[1] + points[3]) / 2;
        label.position({ x: midX, y: midY });
        const textWidth = labelText.width();
        const textHeight = labelText.height();
        const bgWidth = textWidth * 1.2;
        const bgHeight = textHeight * 2;
        labelBg.size({
          width: bgWidth,
          height: bgHeight,
        });
        labelText.position({
          x: (bgWidth - textWidth) / 2,
          y: (bgHeight - textHeight) / 2,
        });
        const rect = label.getClientRect({ relativeTo: layer });
        label.offsetX(rect.width / 2);
        label.offsetY(rect.height / 2);
        label.moveToTop();
      }
    });
    states.forEach((state) => {
      const node = layer.findOne('#' + state.id);
      const label = layer.findOne('#' + state.id + '-label');
      if (node) {
        node.moveToTop();
      }
      if (label) {
        label.moveToTop();
      }
    });
  }

  function getStagePointFromPointer(pointer) {
    const scale = stage.scaleX();
    return {
      x: (pointer.x - stage.x()) / scale,
      y: (pointer.y - stage.y()) / scale,
    };
  }

  function updateTempTransition(pointer) {
    if (!pendingTransitionFrom || !pointer) {
      return;
    }
    const shape = stage.getIntersection(pointer);
    if (shape && shape.id && shape.id() === pendingTransitionFrom) {
      tempTransition.visible(false);
      layer.batchDraw();
      return;
    }
    const fromNode = layer.findOne('#' + pendingTransitionFrom);
    if (!fromNode) {
      return;
    }
    const stagePoint = getStagePointFromPointer(pointer);
    const points = getTransitionPoints(fromNode.position(), stagePoint);
    tempTransition.points(points);
    tempTransition.visible(true);
    tempTransition.moveToTop();
    layer.batchDraw();
  }

  function startEditingStateLabel(state, label) {
    if (activeLabelEditor) {
      activeLabelEditor.remove();
      activeLabelEditor = null;
    }

    const stageBox = stage.container().getBoundingClientRect();
    const labelPosition = label.getAbsolutePosition();
    const inputWidth = Math.max(label.width(), 100);
    const inputHeight = label.height();
    const areaPosition = {
      x: stageBox.left + labelPosition.x - inputWidth / 2,
      y: stageBox.top + labelPosition.y - inputHeight / 2,
    };

    const input = document.createElement('input');
    input.type = 'text';
    input.value = state.label || label.text();
    input.style.position = 'absolute';
    input.style.top = `${areaPosition.y}px`;
    input.style.left = `${areaPosition.x}px`;
    input.style.width = `${inputWidth}px`;
    input.style.height = `${inputHeight}px`;
    input.style.fontSize = `${label.fontSize()}px`;
    input.style.fontFamily = label.fontFamily();
    input.style.color = label.fill();
    input.style.background = 'rgba(0,0,0,0.6)';
    input.style.border = '1px solid #4aa3ff';
    input.style.padding = '10px';
    input.style.margin = '0';
    input.style.textAlign = 'center';
    input.style.outline = 'none';
    input.style.boxSizing = 'border-box';

    document.body.appendChild(input);
    input.focus();
    input.select();
    activeLabelEditor = input;

    const cleanup = () => {
      if (activeLabelEditor) {
        activeLabelEditor.remove();
        activeLabelEditor = null;
      }
    };

    const commit = () => {
      const newText = input.value.trim();
      state.label = newText ? newText : state.label;
      label.text(state.label || state.id);
      cleanup();
      updateObjects();
      layer.batchDraw();
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cleanup();
      }
    });

    input.addEventListener('blur', () => {
      commit();
    });
  }

// generate nodes for the app
  function createTransition(transition) {
    const line = new Konva.Arrow({
      stroke: COLORS.transitionCyan,
      id: transition.id,
      fill: COLORS.transitionCyan,
      pointerLength: 8,
      pointerWidth: 8,
    });
    layer.add(line);

    const label = new Konva.Group({
      id: transition.id + '-label',
      listening: true,
    });
    const labelBg = new Konva.Rect({
      id: transition.id + '-label-bg',
      fill: 'rgb(99, 99, 99)',
      cornerRadius: 8,
      width: 0,
      height: 0,
      listening: true,
    });
    const labelText = new Konva.Text({
      id: transition.id + '-label-text',
      text: `${getStateLabelById(transition.from)} to ${getStateLabelById(transition.to)}`,
      fontSize: 12,
      fontFamily: 'Arial',
      fill: COLORS.label,
      align: 'center',
      listening: true,
    });
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

    const handleMiddleClick = (event) => {
      if (event.evt.button !== 1) {
        return;
      }
      event.evt.preventDefault();
      removeTransition(transition.id);
    };

    labelBg.on('mousedown', handleMiddleClick);
    labelText.on('mousedown', handleMiddleClick);
  }

  function removeTransition(transitionId, skipUpdate = false) {
    const index = transitions.findIndex(
      (transition) => transition.id === transitionId
    );
    if (index === -1) {
      return;
    }
    transitions.splice(index, 1);
    const line = layer.findOne('#' + transitionId);
    const label = layer.findOne('#' + transitionId + '-label');
    if (line) {
      line.destroy();
    }
    if (label) {
      label.destroy();
    }
    if (!skipUpdate) {
      updateObjects();
      layer.batchDraw();
    }
  }

  function transitionExists(fromId, toId) {
    return transitions.some(
      (transition) => transition.from === fromId && transition.to === toId
    );
  }

  function addTransition(fromId, toId) {
    if (fromId === toId) {
      return;
    }
    if (transitionExists(fromId, toId)) {
      return;
    }
    const transition = {
      id: 'transition-' + nextTransitionId,
      from: fromId,
      to: toId,
    };
    nextTransitionId += 1;
    transitions.push(transition);
    createTransition(transition);
    updateObjects();
    layer.batchDraw();
   
  }

  transitions.forEach((transition) => {
    createTransition(transition);
  });

  function removeState(stateId) {
    if (states.length <= 1) {
      return;
    }
    const index = states.findIndex((state) => state.id === stateId);
    if (index === -1) {
      return;
    }

    if (pendingTransitionFrom === stateId) {
      pendingTransitionFrom = null;
      tempTransition.visible(false);
    }

    states.splice(index, 1);
    const node = layer.findOne('#' + stateId);
    const label = layer.findOne('#' + stateId + '-label');
    if (node) {
      node.destroy();
    }
    if (label) {
      label.destroy();
    }

    const related = transitions.filter(
      (transition) => transition.from === stateId || transition.to === stateId
    );
    related.forEach((transition) => {
      removeTransition(transition.id, true);
    });

    if (activeStateId === stateId) {
      activeStateId = states.length ? states[0].id : null;
    }
    updateObjects();
    layer.batchDraw();
   
  }

  function createState(state) {
    const isHighlighted = state.id === activeStateId;
    const node = new Konva.Circle({
      id: state.id,
      fill: COLORS.nodeFill,
      stroke: isHighlighted ? COLORS.nodeStrokeHighlight : COLORS.nodeStroke,
      strokeWidth: 4,
      radius: 50,
      shadowBlur: 12,
      shadowColor: COLORS.nodeShadow,
      draggable: true,
    });
    layer.add(node);

    const label = new Konva.Text({
      id: state.id + '-label',
      text: state.label || state.id,
      fontSize: 14,
      fontFamily: 'Arial',
      fill: COLORS.label,
      align: 'center',
      listening: false,
    });
    label.offsetX(label.width() / 2);
    label.offsetY(label.height() / 2);
    layer.add(label);

    node.on('contextmenu', (event) => {
      event.evt.preventDefault();
      pendingTransitionFrom = state.id;
      updateTempTransition(stage.getPointerPosition());
    });

    node.on('mousedown', (event) => {
      if (event.evt.button === 1) {
        event.evt.preventDefault();
        removeState(state.id);
        return;
      }
      if (event.evt.button === 0 && event.evt.altKey) {
        activeStateId = state.id;
        updateObjects();
        layer.batchDraw();
        return;
      }
      if (event.evt.button !== 0) {
        return;
      }
      if (!pendingTransitionFrom) {
        return;
      }

      const fromId = pendingTransitionFrom;
      pendingTransitionFrom = null;
      tempTransition.visible(false);
      addTransition(fromId, state.id);
    });


    node.on('dragstart', () => {
      node.moveToTop();
      label.moveToTop();
      layer.batchDraw();
    });

    node.on('dragmove', () => {
      // mutate the state
      state.x = node.x();
      state.y = node.y();

      // update nodes from the new state
      updateObjects();
    });

   

    node.on('dblclick', (event) => {
      event.cancelBubble = true;
      startEditingStateLabel(state, label);
    });
  }

  function addStateAt(x, y) {
    const state = {
      id: 'state-' + nextStateId,
      label: 'state-' + nextStateId,
      x,
      y,
    };
    nextStateId += 1;
    states.push(state);
    createState(state);
    updateObjects();
    layer.batchDraw();
   
  }

  states.forEach((state) => {
    createState(state);
  });

  updateObjects();

  stage.on('dblclick', (e) => {
    if (e.target !== stage) {
      return;
    }

    const pointer = stage.getPointerPosition();
    if (!pointer) {
      return;
    }

    const scale = stage.scaleX();
    const x = (pointer.x - stage.x()) / scale;
    const y = (pointer.y - stage.y()) / scale;
    addStateAt(x, y);
  });

  stage.on('mousedown', (e) => {
    if (e.target !== stage) {
      return;
    }
    if (e.evt.button !== 0) {
      return;
    }
    if (!pendingTransitionFrom) {
      return;
    }
    pendingTransitionFrom = null;
    tempTransition.visible(false);
    layer.batchDraw();
  });

  stage.on('mousemove', () => {
    if (!pendingTransitionFrom) {
      return;
    }
    updateTempTransition(stage.getPointerPosition());
  });

  const scaleBy = 1.05;
  stage.on('wheel', (e) => {
    // stop default scrolling
    e.evt.preventDefault();

    const oldScale = stage.scaleX();
    const pointer = stage.getPointerPosition();

    if (!pointer) {
      return;
    }

    const mousePointTo = {
      x: (pointer.x - stage.x()) / oldScale,
      y: (pointer.y - stage.y()) / oldScale,
    };

    // how to scale? Zoom in? Or zoom out?
    let direction = e.evt.deltaY > 0 ? 1 : -1;

    // when we zoom on trackpad, e.evt.ctrlKey is true
    // in that case lets revert direction
    if (e.evt.ctrlKey) {
      direction = -direction;
    }

    const newScale = direction > 0 ? oldScale * scaleBy : oldScale / scaleBy;

    stage.scale({ x: newScale, y: newScale });

    const newPos = {
      x: pointer.x - mousePointTo.x * newScale,
      y: pointer.y - mousePointTo.y * newScale,
    };
    stage.position(newPos);
    stage.batchDraw();
  });

  const container = stage.container();

  container.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });

  container.addEventListener('mousedown', (e) => {
    if (e.button !== 2) {
      return;
    }
    const pointer = stage.getPointerPosition();
    const shape = pointer ? stage.getIntersection(pointer) : null;
    if (shape && shape instanceof Konva.Circle) {
      return;
    }
    e.preventDefault();
    stage.draggable(true);
    stage.startDrag(e);
  });

  container.addEventListener('mouseup', (e) => {
    if (e.button !== 2) {
      return;
    }
    e.preventDefault();
    stage.draggable(false);
    stage.stopDrag();
  });

  container.addEventListener('mouseleave', () => {
    stage.draggable(false);
    stage.stopDrag();
  });
});
