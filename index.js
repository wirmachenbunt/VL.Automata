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
    connectorCyan: '#28e5ff',
  };

  const stage = new Konva.Stage({
    container: 'container',
    width: width,
    height: height,
  });

  const layer = new Konva.Layer();
  stage.add(layer);

  let nextTargetId = 0;
  const targets = [
    {
      id: 'target-' + nextTargetId,
      label: 'target-' + nextTargetId,
      x: stage.width() / 2,
      y: stage.height() / 2,
    },
  ];
  nextTargetId += 1;
  let activeTargetId = targets[0].id;
  let activeLabelEditor = null;

  function getTargetLabelById(targetId) {
    const target = targets.find((item) => item.id === targetId);
    return target ? target.label || target.id : targetId;
  }


function getConnectorPoints(from, to) {
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

  const connectors = [];
  let nextConnectorId = 0;
  let pendingConnectorFrom = null;
  const tempConnector = new Konva.Arrow({
    stroke: COLORS.connectorCyan,
    fill: COLORS.connectorCyan,
    pointerLength: 8,
    pointerWidth: 8,
    dash: [6, 4],
    listening: false,
    visible: false,
  });
  layer.add(tempConnector);

// update all objects on the canvas from the state of the app
  function updateObjects() {
    targets.forEach((target) => {
      const node = layer.findOne('#' + target.id);
      const label = layer.findOne('#' + target.id + '-label');
      if (node) {
        const isHighlighted = activeTargetId && target.id === activeTargetId;
        node.stroke(
          isHighlighted ? COLORS.nodeStrokeHighlight : COLORS.nodeStroke
        );
      }
      node.x(target.x);
      node.y(target.y);
      if (label) {
        label.text(target.label || target.id);
        label.x(target.x);
        label.y(target.y);
        label.offsetX(label.width() / 2);
        label.offsetY(label.height() / 2);
      }
    });
    connectors.forEach((connect) => {
      const line = layer.findOne('#' + connect.id);
      const label = layer.findOne('#' + connect.id + '-label');
      const labelText = layer.findOne('#' + connect.id + '-label-text');
      const labelBg = layer.findOne('#' + connect.id + '-label-bg');
      const fromNode = layer.findOne('#' + connect.from);
      const toNode = layer.findOne('#' + connect.to);

      if (!fromNode || !toNode) {
        return;
      }

      const points = getConnectorPoints(
        fromNode.position(),
        toNode.position()
      );
      line.points(points);
      if (label && labelText && labelBg) {
        labelText.text(
          `${getTargetLabelById(connect.from)} to ${getTargetLabelById(connect.to)}`
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
    targets.forEach((target) => {
      const node = layer.findOne('#' + target.id);
      const label = layer.findOne('#' + target.id + '-label');
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

  function updateTempConnector(pointer) {
    if (!pendingConnectorFrom || !pointer) {
      return;
    }
    const shape = stage.getIntersection(pointer);
    if (shape && shape.id && shape.id() === pendingConnectorFrom) {
      tempConnector.visible(false);
      layer.batchDraw();
      return;
    }
    const fromNode = layer.findOne('#' + pendingConnectorFrom);
    if (!fromNode) {
      return;
    }
    const stagePoint = getStagePointFromPointer(pointer);
    const points = getConnectorPoints(fromNode.position(), stagePoint);
    tempConnector.points(points);
    tempConnector.visible(true);
    tempConnector.moveToTop();
    layer.batchDraw();
  }

  function startEditingTargetLabel(target, label) {
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
    input.value = target.label || label.text();
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
      target.label = newText ? newText : target.label;
      label.text(target.label || target.id);
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
  function createConnector(connect) {
    const line = new Konva.Arrow({
      stroke: COLORS.connectorCyan,
      id: connect.id,
      fill: COLORS.connectorCyan,
      pointerLength: 8,
      pointerWidth: 8,
    });
    layer.add(line);

    const label = new Konva.Group({
      id: connect.id + '-label',
      listening: true,
    });
    const labelBg = new Konva.Rect({
      id: connect.id + '-label-bg',
      fill: 'rgb(99, 99, 99)',
      cornerRadius: 8,
      width: 0,
      height: 0,
      listening: true,
    });
    const labelText = new Konva.Text({
      id: connect.id + '-label-text',
      text: `${getTargetLabelById(connect.from)} to ${getTargetLabelById(connect.to)}`,
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
      removeConnector(connect.id);
    };

    labelBg.on('mousedown', handleMiddleClick);
    labelText.on('mousedown', handleMiddleClick);
  }

  function removeConnector(connectorId, skipUpdate = false) {
    const index = connectors.findIndex(
      (connector) => connector.id === connectorId
    );
    if (index === -1) {
      return;
    }
    connectors.splice(index, 1);
    const line = layer.findOne('#' + connectorId);
    const label = layer.findOne('#' + connectorId + '-label');
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

  function connectorExists(fromId, toId) {
    return connectors.some(
      (connector) => connector.from === fromId && connector.to === toId
    );
  }

  function addConnector(fromId, toId) {
    if (fromId === toId) {
      return;
    }
    if (connectorExists(fromId, toId)) {
      return;
    }
    const connect = {
      id: 'connector-' + nextConnectorId,
      from: fromId,
      to: toId,
    };
    nextConnectorId += 1;
    connectors.push(connect);
    createConnector(connect);
    updateObjects();
    layer.batchDraw();
  }

  connectors.forEach((connect) => {
    createConnector(connect);
  });

  function removeTarget(targetId) {
    if (targets.length <= 1) {
      return;
    }
    const index = targets.findIndex((target) => target.id === targetId);
    if (index === -1) {
      return;
    }

    if (pendingConnectorFrom === targetId) {
      pendingConnectorFrom = null;
      tempConnector.visible(false);
    }

    targets.splice(index, 1);
    const node = layer.findOne('#' + targetId);
    const label = layer.findOne('#' + targetId + '-label');
    if (node) {
      node.destroy();
    }
    if (label) {
      label.destroy();
    }

    const related = connectors.filter(
      (connector) => connector.from === targetId || connector.to === targetId
    );
    related.forEach((connector) => {
      removeConnector(connector.id, true);
    });

    if (activeTargetId === targetId) {
      activeTargetId = targets.length ? targets[0].id : null;
    }
    updateObjects();
    layer.batchDraw();
  }

  function createTarget(target) {
    const isHighlighted = target.id === activeTargetId;
    const node = new Konva.Circle({
      id: target.id,
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
      id: target.id + '-label',
      text: target.label || target.id,
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
      pendingConnectorFrom = target.id;
      updateTempConnector(stage.getPointerPosition());
    });

    node.on('mousedown', (event) => {
      if (event.evt.button === 1) {
        event.evt.preventDefault();
        removeTarget(target.id);
        return;
      }
      if (event.evt.button !== 0) {
        return;
      }
      if (!pendingConnectorFrom) {
        return;
      }

      const fromId = pendingConnectorFrom;
      pendingConnectorFrom = null;
      tempConnector.visible(false);
      addConnector(fromId, target.id);
    });


    node.on('dragstart', () => {
      node.moveToTop();
      label.moveToTop();
      layer.batchDraw();
    });

    node.on('dragmove', () => {
      // mutate the state
      target.x = node.x();
      target.y = node.y();

      // update nodes from the new state
      updateObjects();
    });

    node.on('dblclick', (event) => {
      event.cancelBubble = true;
      startEditingTargetLabel(target, label);
    });
  }

  function addTargetAt(x, y) {
    const target = {
      id: 'target-' + nextTargetId,
      label: 'target-' + nextTargetId,
      x,
      y,
    };
    nextTargetId += 1;
    targets.push(target);
    createTarget(target);
    updateObjects();
    layer.batchDraw();
  }

  targets.forEach((target) => {
    createTarget(target);
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
    addTargetAt(x, y);
  });

  stage.on('mousedown', (e) => {
    if (e.target !== stage) {
      return;
    }
    if (e.evt.button !== 0) {
      return;
    }
    if (!pendingConnectorFrom) {
      return;
    }
    pendingConnectorFrom = null;
    tempConnector.visible(false);
    layer.batchDraw();
  });

  stage.on('mousemove', () => {
    if (!pendingConnectorFrom) {
      return;
    }
    updateTempConnector(stage.getPointerPosition());
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
