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

// function to generate a list of "targets" (circles)
function generateTargets() {
  const number = 10;
  const result = [];
  while (result.length < number) {
    result.push({
      id: 'target-' + result.length,
      x: stage.width() * Math.random(),
      y: stage.height() * Math.random(),
    });
  }
  return result;
}

  const targets = generateTargets();

// function to generate arrows between targets
function generateConnectors() {
  const number = 10;
  const result = [];
  while (result.length < number) {
    const from = 'target-' + Math.floor(Math.random() * targets.length);
    const to = 'target-' + Math.floor(Math.random() * targets.length);
    if (from === to) {
      continue;
    }
    result.push({
      id: 'connector-' + result.length,
      from: from,
      to: to,
    });
  }
  return result;
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

  const connectors = generateConnectors();

// update all objects on the canvas from the state of the app
  function updateObjects() {
    targets.forEach((target) => {
      const node = layer.findOne('#' + target.id);
      const label = layer.findOne('#' + target.id + '-label');
      node.x(target.x);
      node.y(target.y);
      if (label) {
        label.x(target.x);
        label.y(target.y);
      }
    });
    connectors.forEach((connect) => {
      const line = layer.findOne('#' + connect.id);
      const fromNode = layer.findOne('#' + connect.from);
      const toNode = layer.findOne('#' + connect.to);

      const points = getConnectorPoints(
        fromNode.position(),
        toNode.position()
      );
      line.points(points);
    });
  }

// generate nodes for the app
  connectors.forEach((connect) => {
    const line = new Konva.Arrow({
      stroke: COLORS.connectorCyan,
      id: connect.id,
      fill: COLORS.connectorCyan,
      pointerLength: 8,
      pointerWidth: 8,
    });
    layer.add(line);
  });

  targets.forEach((target) => {
    const isHighlighted = target.id === 'target-4';
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
      text: target.id,
      fontSize: 14,
      fontFamily: 'Arial',
      fill: COLORS.label,
      align: 'center',
      listening: false,
    });
    label.offsetX(label.width() / 2);
    label.offsetY(label.height() / 2);
    layer.add(label);

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
  });

  updateObjects();

  const scaleBy = 1.01;
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
