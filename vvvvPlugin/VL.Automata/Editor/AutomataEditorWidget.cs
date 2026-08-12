using System.Globalization;
using System.Numerics;
using ImGuiNET;
using VL.Automata.Engine;
using VL.ImGui;
using VL.ImGui.Widgets;

// Inside namespace VL.Automata the bare name "ImGui" would bind to the sibling
// namespace VL.ImGui; alias it to the ImGui.NET static class we actually call.
using IG = ImGuiNET.ImGui;
// Disambiguate: this enum exists in both VL.ImGui and ImGuiNET.
using ImGuiInputTextFlags = ImGuiNET.ImGuiInputTextFlags;

namespace VL.Automata;

// The editor window, hand-drawn with ImGui's DrawList — the vvvv counterpart of
// the cables Konva editor (att_inc_editor.js). Exposed as a VL.ImGui.Widget; the
// node wraps it into a Skia layer (ToSkiaLayer) rendered in its own window.
//
// The canvas has a pan/zoom view transform: everything is stored in document
// coordinates and mapped to screen via ToScreen()/ToDoc().
//
// Interactions (matching the cables editor):
//   • double-click empty canvas  → add state
//   • drag a state               → move it
//   • double-click a state       → edit its label
//   • right-click a state, then left-click another → create a transition
//   • double-click a transition  → edit its frame delay
//   • Ctrl+click a state         → force the machine into it
//   • Ctrl+click a transition    → run it now (jump to "from", then start)
//   • Alt / Middle + click a state / transition / region → delete
//   • Alt + drag empty canvas    → create a region (drag out the radius)
//   • double-click a region      → edit its title
//   • drag a region body → move; drag its edge → resize
//   • drag empty canvas  → pan;  mouse wheel → zoom
public sealed class AutomataEditorWidget : IDisposable
{
    private const float StateRadius = (float)AutomataEngine.StateRadius;
    private const float TransitionHitDist = 6f;
    private const float RegionEdgeDist = 8f;
    private const float MinRegionRadius = 8f;
    private const float MinZoom = 0.2f, MaxZoom = 4f;

    private readonly string _title;
    private int _newStateCounter;

    public AutomataDocument Document { get; private set; }
    // When false the canvas is drawn transparent — both the explicit fill AND ImGui's own
    // window background are skipped — so whatever is behind the renderer shows through.
    public bool ShowBackground = true;
    public Action? Changed;
    // Supplies the engine's current active state / pending transition for highlight.
    public Func<string?>? ActiveStateId;
    public Func<string?>? PendingTransitionId;
    // Ctrl+click shortcuts that drive the running engine directly.
    public Action<string>? ForceState;
    public Action<string>? ForceTransition;
    public Widget Widget { get; }

    // view transform (screen = origin + pan + doc * zoom)
    private Vector2 _origin;
    private Vector2 _pan;
    private float _zoom = 1f;

    // View state (pan/zoom) is session-transient, not part of the document. Exposed so a
    // reload can carry it across a rebuilt widget instead of snapping back to the default
    // view (see AutomataNode.LoadIfChanged).
    public Vector2 Pan { get => _pan; set => _pan = value; }
    public float Zoom { get => _zoom; set => _zoom = value; }
    // right-button: drag = pan, click on a state = start transition
    private bool _rightMoved;
    private string? _rightDownState;

    // interaction state
    private string? _draggingStateId;
    private string? _pendingFrom;          // transition being created, from this state
    private string? _draggingRegionId;
    private string? _resizingRegionId;
    private Vector2 _regionDragOffset;
    private Vector2? _regionDraftCenter;    // Alt-drag region creation in progress

    // inline editing
    private enum EditKind { None, StateLabel, TransitionFrames, RegionTitle }
    private EditKind _editKind;
    private string _editStateOrTransitionId = "";
    private string _editBuffer = "";
    private bool _focusEdit;

    public AutomataEditorWidget(string filePath, AutomataDocument doc)
    {
        _title = Path.GetFileNameWithoutExtension(filePath);
        Document = doc;
        _newStateCounter = doc.States.Count;
        Widget = new ImmediateModeWidget { Updator = Draw };
    }

    private static uint Col(float r, float g, float b, float a = 1f)
        => IG.GetColorU32(new Vector4(r, g, b, a));

    // ---- view transform ----
    private Vector2 ToScreen(double x, double y) => _origin + _pan + new Vector2((float)x, (float)y) * _zoom;
    private Vector2 ToScreen(Vector2 doc) => _origin + _pan + doc * _zoom;
    private Vector2 ToDoc(Vector2 screenLocal) => (screenLocal - _pan) / _zoom;
    private float Z(float len) => len * _zoom;

    private StateData? StateById(string id) => Document.States.FirstOrDefault(s => s.Id == id);
    private Vector2 StateScreen(StateData s) => ToScreen(s.X, s.Y);
    private static string TransitionKey(TransitionData t) =>
        !string.IsNullOrWhiteSpace(t.Id) ? t.Id : $"{t.From}-to-{t.To}";

    // Canvas label height in DOCUMENT units — the SAME space as the geometry (StateRadius = 96,
    // paddings, gaps). Sizing type in document units (rather than off IG.GetFontSize(), which
    // carries the host's Windows-scaling / DPI factor) is what keeps the type-to-graphics
    // proportion identical on every monitor: it's fixed by these two constants alone. Tune this
    // for label size — it is capped for crispness by the atlas bake size (AutomataNode.FontBakeSize):
    // keep LabelFontSize * MaxZoom  <=  FontBakeSize * 100, else deep zoom re-softens the glyphs.
    private const float LabelFontSize = 28f;
    // The atlas is baked much larger than we display (see AutomataNode.FontBakeSize) so it stays
    // crisp when zoomed. IG.GetFontSize() is that bake size; used only to rescale CalcTextSize
    // (measured at the bake size) down into our document-unit label size.
    private float FontDocScale => LabelFontSize / IG.GetFontSize();
    // VL.ImGui's DIP source (ToImGuiScaling = DIPFactor * 100). Canvas content is DPI-independent
    // by construction (document units); only the fixed help HUD uses this, to hold a constant
    // *physical* size regardless of scaling or bake size. See DEVNOTES "DPI / UI scaling".
    private static float DipFactor => MathF.Max(0.01f, ImGuiConversion.ToImGuiScaling / 100f);

    private void Text(ImDrawListPtr dl, Vector2 topLeft, uint col, string text)
        => dl.AddText(IG.GetFont(), LabelFontSize * _zoom, topLeft, col, text);
    // Text extent in DOCUMENT units, matching what Text() draws (i.e. TextSize / zoom).
    private Vector2 TextSizeDoc(string text) => IG.CalcTextSize(text) * FontDocScale;
    private Vector2 TextSize(string text) => TextSizeDoc(text) * _zoom;

    private void Draw(Context context)
    {
        // Fill the whole Skia canvas from its top-left origin (renderer Space =
        // DIPTopLeft), with no decorations.
        var io = IG.GetIO();
        Vector2 display = io.DisplaySize;
        IG.SetNextWindowPos(Vector2.Zero);
        IG.SetNextWindowSize(display);
        ImGuiWindowFlags flags =
            ImGuiWindowFlags.NoTitleBar | ImGuiWindowFlags.NoResize | ImGuiWindowFlags.NoMove |
            ImGuiWindowFlags.NoCollapse | ImGuiWindowFlags.NoScrollbar |
            ImGuiWindowFlags.NoScrollWithMouse | ImGuiWindowFlags.NoBringToFrontOnFocus;
        // Drop ImGui's own window background too, else it paints under the (skipped) fill.
        if (!ShowBackground) flags |= ImGuiWindowFlags.NoBackground;

        IG.PushStyleVar(ImGuiStyleVar.WindowPadding, Vector2.Zero);
        bool open = IG.Begin("Automata — " + _title, flags);
        IG.PopStyleVar();
        if (!open) { IG.End(); return; }

        _origin = IG.GetCursorScreenPos();
        Vector2 size = IG.GetContentRegionAvail();
        if (size.X < 16) size.X = 16;
        if (size.Y < 16) size.Y = 16;

        IG.InvisibleButton("automata-canvas", size);
        bool canvasHovered = IG.IsItemHovered();
        var dl = IG.GetWindowDrawList();
        Vector2 mouseLocal = IG.GetMousePos() - _origin;

        // Zoom around the cursor.
        if (canvasHovered && io.MouseWheel != 0f)
        {
            float old = _zoom;
            _zoom = Math.Clamp(_zoom * MathF.Pow(1.1f, io.MouseWheel), MinZoom, MaxZoom);
            Vector2 docUnderMouse = (mouseLocal - _pan) / old;
            _pan = mouseLocal - docUnderMouse * _zoom;
        }

        Vector2 mouse = ToDoc(mouseLocal); // document coords

        if (ShowBackground)
            dl.AddRectFilled(_origin, _origin + size, Col(0.11f, 0.12f, 0.13f));

        DrawRegions(dl);
        DrawTransitions(dl);
        // Draw the in-progress connection *before* the states so it passes behind them.
        DrawPendingTransition(dl, mouseLocal);
        DrawStates(dl);
        DrawRegionDraft(dl, mouse);
        DrawHelp(dl, size);
        DrawZoomLabel(dl, size);

        if (_editKind != EditKind.None)
            DrawInlineEdit();
        else
            HandleInteraction(canvasHovered, mouse, io.KeyAlt, io.KeyCtrl);

        IG.End();
    }

    // ---------------------------- drawing ------------------------------------

    private void DrawRegions(ImDrawListPtr dl)
    {
        var activeState = StateById(ActiveStateId?.Invoke() ?? "");
        foreach (var r in Document.Regions)
        {
            var c = ToScreen(r.X, r.Y);
            float rad = Z((float)r.Radius);
            bool on = activeState is not null && IsStateInRegion(activeState, r);
            // cables REGION_* colours (rgba 64,180,255 / 120,220,255)
            uint fill = on ? Col(0.251f, 0.706f, 1f, 0.22f) : Col(0.251f, 0.706f, 1f, 0.12f);
            uint stroke = on ? Col(0.471f, 0.863f, 1f, 0.88f) : Col(0.251f, 0.706f, 1f, 0.50f);
            dl.AddCircleFilled(c, rad, fill);
            dl.AddCircle(c, rad, stroke, 0, on ? 2f : 1.5f);
            string title = string.IsNullOrWhiteSpace(r.Title) ? r.Id : r.Title;
            uint titleCol = on ? Col(0.96f, 0.99f, 1f) : Col(0.863f, 0.941f, 1f, 0.95f);
            // Centred on the circle centre, like the cables editor (title at region x/y
            // with offset = size/2). Text() takes a top-left, so subtract half the size.
            Text(dl, c - TextSize(title) * 0.5f, titleCol, title);
        }
    }

    private static bool IsStateInRegion(StateData s, RegionData r)
    {
        float dx = (float)s.X - (float)r.X, dy = (float)s.Y - (float)r.Y;
        return MathF.Sqrt(dx * dx + dy * dy) <= (float)r.Radius + StateRadius;
    }

    // A transition gets a small perpendicular shift when its reverse (to→from) also exists,
    // so the two are drawn — and picked — with a gap instead of overlapping. Returns the unit
    // left normal (or zero: no reverse / degenerate). Each direction uses its own left normal,
    // so the pair separates symmetrically. Scale it by Z(TransitionGap) in screen space, or by
    // TransitionGap directly in document space.
    private const float TransitionGap = 16f; // document units, each side
    // When two states have transitions both ways, slide each label to 30% along its own
    // direction. Since the reverse runs the other way, the pair lands at 30% and 70% of the
    // line, so the labels no longer stack. A lone transition keeps its label centred.
    private const float LabelFracWithReverse = 0.30f;
    // Label pill padding: a small fixed gap around the text (document units), so the pill
    // hugs the text with constant breathing room rather than padding proportional to length.
    private const float LabelPadX = 9f;
    private const float LabelPadY = 5f;

    private bool HasReverseTransition(TransitionData t) =>
        Document.Transitions.Any(o => o is not null && o.From == t.To && o.To == t.From);

    private float TransitionLabelFrac(TransitionData t) =>
        HasReverseTransition(t) ? LabelFracWithReverse : 0.5f;

    private Vector2 TransitionGapNormal(TransitionData t, Vector2 a, Vector2 b)
    {
        if (a == b || !HasReverseTransition(t)) return Vector2.Zero;
        var dir = Vector2.Normalize(b - a);
        return new Vector2(-dir.Y, dir.X);
    }

    private void DrawTransitions(ImDrawListPtr dl)
    {
        string? pending = PendingTransitionId?.Invoke();
        foreach (var t in Document.Transitions)
        {
            var from = StateById(t.From);
            var to = StateById(t.To);
            if (from is null || to is null) continue;
            var a = StateScreen(from);
            var b = StateScreen(to);
            if (a == b) continue;
            bool active = pending == TransitionKey(t);
            uint col = active ? Col(1f, 0.82f, 0.40f) : Col(0.16f, 0.90f, 1f);

            var dir = Vector2.Normalize(b - a);
            var off = TransitionGapNormal(t, a, b) * Z(TransitionGap);
            var a0 = a + dir * Z(StateRadius) + off;
            var b0 = b - dir * Z(StateRadius) + off;
            dl.AddLine(a0, b0, col, active ? 3f : 2f);
            var n = new Vector2(-dir.Y, dir.X);
            dl.AddTriangleFilled(b0, b0 - dir * Z(24) + n * Z(12), b0 - dir * Z(24) - n * Z(12), col);

            // Label sits at 30%/70% when a reverse transition exists (else centred), so the
            // two labels don't overlap.
            var mid = a0 + (b0 - a0) * TransitionLabelFrac(t);
            string label = TransitionLabel(t, from, to);
            var ts = TextSize(label);
            // Pill hugs the text with a small fixed gap each side (see LabelPadX/Y).
            var half = ts * 0.5f + new Vector2(Z(LabelPadX), Z(LabelPadY));
            float round = MathF.Min(half.Y, Z(10));
            uint bg = active ? Col(0.553f, 0.435f, 0.180f, 0.95f) : Col(0.388f, 0.388f, 0.388f, 0.95f);
            dl.AddRectFilled(mid - half, mid + half, bg, round);
            Text(dl, mid - ts * 0.5f, Col(0.918f, 0.969f, 1f), label);
        }
    }

    private void DrawStates(ImDrawListPtr dl)
    {
        string? active = ActiveStateId?.Invoke();
        float rad = Z(StateRadius);
        float thick = Math.Max(3f, Z(6f)); // 50% thicker than the cables strokeWidth 4
        foreach (var s in Document.States)
        {
            var p = StateScreen(s);
            bool isActive = s.Id == active;
            bool isPendingFrom = s.Id == _pendingFrom;

            DrawSoftShadow(dl, p, rad);
            dl.AddCircleFilled(p, rad, Col(0.184f, 0.184f, 0.184f)); // #2f2f2f
            // Only the active state gets the orange highlight (#f6a21a), exactly
            // like the cables editor; a pending transition source glows amber.
            uint ring = isActive ? Col(0.965f, 0.635f, 0.102f)
                : isPendingFrom ? Col(0.95f, 0.20f, 0.20f)         // matches the pending-connection line
                : Col(0.055f, 0.067f, 0.075f);                     // #0e1113
            dl.AddCircle(p, rad, ring, 0, thick);
            string label = string.IsNullOrWhiteSpace(s.Label) ? s.Id : s.Label;
            var ts = TextSize(label);
            Text(dl, p - ts * 0.5f, Col(0.918f, 0.969f, 1f), label); // #eaf7ff
        }
    }

    // Fake Konva-style drop shadow (shadowBlur 12, rgba(0,0,0,0.35)): stacked
    // translucent circles, offset slightly down, fading outward.
    private void DrawSoftShadow(ImDrawListPtr dl, Vector2 center, float radius)
    {
        var c = center + new Vector2(0, Z(3));
        for (int i = 5; i >= 1; i--)
            dl.AddCircleFilled(c, radius + i * Z(2), Col(0f, 0f, 0f, 0.07f));
    }

    private void DrawPendingTransition(ImDrawListPtr dl, Vector2 mouseLocal)
    {
        if (_pendingFrom is null) return;
        var from = StateById(_pendingFrom);
        if (from is null) return;
        dl.AddLine(StateScreen(from), _origin + mouseLocal, Col(0.95f, 0.20f, 0.20f, 0.9f), 2f);
    }

    private void DrawRegionDraft(ImDrawListPtr dl, Vector2 mouse)
    {
        if (_regionDraftCenter is not Vector2 center) return;
        float radius = Z((mouse - center).Length());
        var c = ToScreen(center);
        dl.AddCircleFilled(c, radius, Col(0.25f, 0.70f, 1f, 0.08f));
        dl.AddCircle(c, radius, Col(0.25f, 0.70f, 1f, 0.6f), 0, 1.5f);
    }

    private void DrawHelp(ImDrawListPtr dl, Vector2 size)
    {
        const string help = "dbl-click: add state / rename  |  right-click state → click target: transition  |  " +
                            "Ctrl+click: force state / run transition  |  Alt or Middle click: delete  |  " +
                            "Alt+drag: region  |  right-drag: pan  |  wheel: zoom";
        // A fixed-size HUD, not canvas content: draw at an explicit small size (the default font
        // is now the large bake size) held constant in physical pixels via DipFactor, so it
        // neither zooms nor changes with DPI. Measure at the same size to place it flush bottom-left.
        float helpPx = 15f * DipFactor;
        var ts = IG.CalcTextSize(help) * (helpPx / IG.GetFontSize());
        dl.AddText(IG.GetFont(), helpPx, _origin + new Vector2(8, size.Y - ts.Y - 8), Col(0.5f, 0.55f, 0.6f), help);
    }

    // Current zoom as a percentage, pinned top-right. Same fixed-size HUD treatment as DrawHelp
    // (constant physical size via DipFactor; neither zooms nor changes with DPI). Right-aligned,
    // so subtract the measured width from the right edge.
    private void DrawZoomLabel(ImDrawListPtr dl, Vector2 size)
    {
        string label = $"{MathF.Round(_zoom * 100f)}%";
        float px = 15f * DipFactor;
        var ts = IG.CalcTextSize(label) * (px / IG.GetFontSize());
        dl.AddText(IG.GetFont(), px, _origin + new Vector2(size.X - ts.X - 8, 8), Col(0.5f, 0.55f, 0.6f), label);
    }

    // ---------------------------- interaction --------------------------------

    private void HandleInteraction(bool hovered, Vector2 mouse, bool alt, bool ctrl)
    {
        // continue an in-progress drag first
        if (_draggingStateId is not null) { ContinueStateDrag(); return; }
        if (_resizingRegionId is not null) { ContinueRegionResize(mouse); return; }
        if (_draggingRegionId is not null) { ContinueRegionDrag(mouse); return; }
        if (_regionDraftCenter is not null) { ContinueRegionDraft(mouse); return; }

        if (!hovered) return;

        var hitState = HitState(mouse);
        var hitTransition = hitState is null ? HitTransition(mouse) : null;
        bool onRegionEdge = false;
        var hitRegion = (hitState is null && hitTransition is null) ? HitRegion(mouse, out onRegionEdge) : null;

        if (IG.IsMouseDoubleClicked(ImGuiMouseButton.Left))
        {
            if (hitState is not null) StartEditStateLabel(hitState);
            else if (hitTransition is not null) StartEditTransitionFrames(hitTransition);
            else if (hitRegion is not null) StartEditRegionTitle(hitRegion);
            else AddState(mouse);
            return;
        }

        // Middle-click deletes a state / transition / region (like Alt+click).
        if (IG.IsMouseClicked(ImGuiMouseButton.Middle))
        {
            if (hitState is not null) RemoveState(hitState.Id);
            else if (hitTransition is not null) RemoveTransition(hitTransition);
            else if (hitRegion is not null) RemoveRegion(hitRegion.Id);
            return;
        }

        // Ctrl+click: force the running machine.
        if (ctrl && IG.IsMouseClicked(ImGuiMouseButton.Left))
        {
            if (hitState is not null) ForceState?.Invoke(hitState.Id);
            else if (hitTransition is not null) ForceTransition?.Invoke(TransitionKey(hitTransition));
            return;
        }

        // Right mouse: drag = pan the canvas; a click (no drag) on a state starts a
        // transition — matches the cables op (button 2 pans, right-click a state
        // begins a transition).
        if (IG.IsMouseClicked(ImGuiMouseButton.Right)) { _rightDownState = hitState?.Id; _rightMoved = false; }
        if (IG.IsMouseDragging(ImGuiMouseButton.Right))
        {
            _pan += IG.GetIO().MouseDelta;
            _rightMoved = true;
            return;
        }
        if (IG.IsMouseReleased(ImGuiMouseButton.Right))
        {
            if (!_rightMoved && !ctrl && _rightDownState is not null) _pendingFrom = _rightDownState;
            _rightDownState = null;
            _rightMoved = false;
            return;
        }

        if (IG.IsMouseClicked(ImGuiMouseButton.Left))
        {
            // complete / cancel a pending transition
            if (_pendingFrom is not null)
            {
                if (hitState is not null) AddTransition(_pendingFrom, hitState.Id);
                _pendingFrom = null;
                return;
            }
            // Alt = delete a shape, or start a region on empty canvas
            if (alt)
            {
                if (hitState is not null) RemoveState(hitState.Id);
                else if (hitTransition is not null) RemoveTransition(hitTransition);
                else if (hitRegion is not null) RemoveRegion(hitRegion.Id);
                else _regionDraftCenter = mouse;
                return;
            }
            if (hitState is not null) { _draggingStateId = hitState.Id; return; }
            if (hitRegion is not null)
            {
                if (onRegionEdge) _resizingRegionId = hitRegion.Id;
                else { _draggingRegionId = hitRegion.Id; _regionDragOffset = mouse - new Vector2((float)hitRegion.X, (float)hitRegion.Y); }
            }
        }
    }

    private void ContinueStateDrag()
    {
        var s = StateById(_draggingStateId!);
        if (s is not null && IG.IsMouseDown(ImGuiMouseButton.Left))
        {
            var d = IG.GetIO().MouseDelta / _zoom; // screen delta → document delta
            s.X += d.X; s.Y += d.Y;
        }
        else { _draggingStateId = null; Changed?.Invoke(); }
    }

    private void ContinueRegionResize(Vector2 mouse)
    {
        var r = Document.Regions.FirstOrDefault(x => x.Id == _resizingRegionId);
        if (r is not null && IG.IsMouseDown(ImGuiMouseButton.Left))
        {
            float radius = new Vector2(mouse.X - (float)r.X, mouse.Y - (float)r.Y).Length();
            r.Radius = Math.Max(MinRegionRadius, radius);
        }
        else { _resizingRegionId = null; Changed?.Invoke(); }
    }

    private void ContinueRegionDrag(Vector2 mouse)
    {
        var r = Document.Regions.FirstOrDefault(x => x.Id == _draggingRegionId);
        if (r is not null && IG.IsMouseDown(ImGuiMouseButton.Left))
        {
            r.X = mouse.X - _regionDragOffset.X;
            r.Y = mouse.Y - _regionDragOffset.Y;
        }
        else { _draggingRegionId = null; Changed?.Invoke(); }
    }

    private void ContinueRegionDraft(Vector2 mouse)
    {
        if (IG.IsMouseDown(ImGuiMouseButton.Left)) return; // still dragging out radius
        var center = _regionDraftCenter!.Value;
        float radius = (mouse - center).Length();
        _regionDraftCenter = null;
        if (radius < MinRegionRadius) return;
        Document.Regions.Add(new RegionData
        {
            Id = "r-" + Guid.NewGuid().ToString("N")[..8],
            X = center.X, Y = center.Y, Radius = radius,
            Title = "Region " + (Document.Regions.Count + 1)
        });
        Changed?.Invoke();
    }

    // ---------------------------- hit tests (document space) -----------------

    private StateData? HitState(Vector2 mouse)
    {
        for (int i = Document.States.Count - 1; i >= 0; i--)
        {
            var s = Document.States[i];
            float dx = (float)s.X - mouse.X, dy = (float)s.Y - mouse.Y;
            if (dx * dx + dy * dy <= StateRadius * StateRadius) return s;
        }
        return null;
    }

    // The label "A to B [Nf]" — one source of truth for drawing and hit-testing.
    private static string TransitionLabel(TransitionData t, StateData from, StateData to)
    {
        string fromLabel = string.IsNullOrWhiteSpace(from.Label) ? from.Id : from.Label;
        string toLabel = string.IsNullOrWhiteSpace(to.Label) ? to.Id : to.Label;
        return $"{fromLabel} to {toLabel} [{Math.Max(0, t.Frames)}f]";
    }

    private TransitionData? HitTransition(Vector2 mouse)
    {
        float tol = TransitionHitDist / _zoom;
        // Reverse order so the topmost-drawn transition wins the hit, like states/regions.
        for (int i = Document.Transitions.Count - 1; i >= 0; i--)
        {
            var t = Document.Transitions[i];
            var from = StateById(t.From);
            var to = StateById(t.To);
            if (from is null || to is null) continue;
            var a = new Vector2((float)from.X, (float)from.Y);
            var b = new Vector2((float)to.X, (float)to.Y);
            if (a == b) continue;
            var dir = Vector2.Normalize(b - a);
            var off = TransitionGapNormal(t, a, b) * TransitionGap; // gap when a reverse exists
            var a0 = a + dir * StateRadius + off;   // trimmed segment (state edge → state edge),
            var b0 = b - dir * StateRadius + off;   // matching the drawn connector line
            var mid = a0 + (b0 - a0) * TransitionLabelFrac(t); // label pos: 30%/70% or centre

            // Primary target: the label pill. Its doc-space half-extent mirrors the drawn
            // screen half-extent (ts*0.5 + Z(LabelPad), ts = raw*zoom) divided by zoom, i.e.
            // raw*0.5 + LabelPad — see DrawTransitions.
            var raw = TextSizeDoc(TransitionLabel(t, from, to));
            var half = raw * 0.5f + new Vector2(LabelPadX, LabelPadY);
            if (Math.Abs(mouse.X - mid.X) <= half.X && Math.Abs(mouse.Y - mid.Y) <= half.Y)
                return t;

            // Fallback: near the connector line itself.
            if (DistToSegment(mouse, a0, b0) <= tol) return t;
        }
        return null;
    }

    private RegionData? HitRegion(Vector2 mouse, out bool onEdge)
    {
        onEdge = false;
        float edge = RegionEdgeDist / _zoom;
        for (int i = Document.Regions.Count - 1; i >= 0; i--)
        {
            var r = Document.Regions[i];
            float dist = new Vector2(mouse.X - (float)r.X, mouse.Y - (float)r.Y).Length();
            if (dist <= r.Radius + edge)
            {
                onEdge = Math.Abs(dist - (float)r.Radius) <= edge;
                return r;
            }
        }
        return null;
    }

    private static float DistToSegment(Vector2 p, Vector2 a, Vector2 b)
    {
        var ab = b - a;
        float len2 = ab.LengthSquared();
        float t = len2 > 0 ? Math.Clamp(Vector2.Dot(p - a, ab) / len2, 0f, 1f) : 0f;
        return (p - (a + ab * t)).Length();
    }

    // ---------------------------- mutations ----------------------------------

    private void AddState(Vector2 pos)
    {
        _newStateCounter++;
        Document.States.Add(new StateData
        {
            Id = "s-" + Guid.NewGuid().ToString("N")[..8],
            Label = "state-" + _newStateCounter,
            X = pos.X, Y = pos.Y
        });
        Changed?.Invoke();
    }

    private void AddTransition(string from, string to)
    {
        if (from == to) return;
        if (Document.Transitions.Any(t => t.From == from && t.To == to)) return;
        Document.Transitions.Add(new TransitionData
        {
            Id = "t-" + Guid.NewGuid().ToString("N")[..8],
            From = from, To = to, Frames = 0
        });
        Changed?.Invoke();
    }

    private void RemoveState(string id)
    {
        var s = StateById(id);
        if (s is null) return;
        if (Document.States.Count <= 1) return;      // keep at least one state
        if (IsStart(s)) return;                       // START may not be deleted
        Document.States.RemoveAll(x => x.Id == id);
        Document.Transitions.RemoveAll(t => t.From == id || t.To == id);
        if (_pendingFrom == id) _pendingFrom = null;
        Changed?.Invoke();
    }

    private static bool IsStart(StateData s) => s.Label?.Trim() == "START";

    private void RemoveTransition(TransitionData t)
    {
        Document.Transitions.Remove(t);
        Changed?.Invoke();
    }

    private void RemoveRegion(string id)
    {
        Document.Regions.RemoveAll(r => r.Id == id);
        Changed?.Invoke();
    }

    // ---------------------------- inline editing -----------------------------

    private void StartEditStateLabel(StateData s)
    {
        _editKind = EditKind.StateLabel;
        _editStateOrTransitionId = s.Id;
        _editBuffer = s.Label ?? "";
        _focusEdit = true;
    }

    private void StartEditRegionTitle(RegionData r)
    {
        _editKind = EditKind.RegionTitle;
        _editStateOrTransitionId = r.Id;
        _editBuffer = r.Title ?? "";
        _focusEdit = true;
    }

    private void StartEditTransitionFrames(TransitionData t)
    {
        _editKind = EditKind.TransitionFrames;
        _editStateOrTransitionId = TransitionKey(t);
        _editBuffer = t.Frames.ToString(CultureInfo.InvariantCulture);
        _focusEdit = true;
    }

    private void DrawInlineEdit()
    {
        // The label being edited is drawn centered on this anchor (state/region centre,
        // or transition midpoint) at the zoomed font size — see DrawStates / DrawTransitions.
        Vector2 anchor;
        if (_editKind == EditKind.StateLabel)
        {
            var s = StateById(_editStateOrTransitionId);
            if (s is null) { _editKind = EditKind.None; return; }
            anchor = StateScreen(s);
        }
        else if (_editKind == EditKind.RegionTitle)
        {
            var r = Document.Regions.FirstOrDefault(x => x.Id == _editStateOrTransitionId);
            if (r is null) { _editKind = EditKind.None; return; }
            anchor = ToScreen(r.X, r.Y);
        }
        else
        {
            var t = Document.Transitions.FirstOrDefault(x => TransitionKey(x) == _editStateOrTransitionId);
            var from = t is null ? null : StateById(t.From);
            var to = t is null ? null : StateById(t.To);
            if (t is null || from is null || to is null) { _editKind = EditKind.None; return; }
            var sa = StateScreen(from);
            var sb = StateScreen(to);
            if (sa == sb) { anchor = sa; }
            else
            {
                // Match the drawn label exactly: trimmed segment + gap, then the 30%/70%
                // (or centre) point along it.
                var dir = Vector2.Normalize(sb - sa);
                var off = TransitionGapNormal(t, sa, sb) * Z(TransitionGap);
                var a0 = sa + dir * Z(StateRadius) + off;
                var b0 = sb - dir * Z(StateRadius) + off;
                anchor = a0 + (b0 - a0) * TransitionLabelFrac(t);
            }
        }

        // Match the label so the field overlays the original text (InputText otherwise renders
        // at the base font size). Text() draws at LabelFontSize * zoom while the baked font is
        // GetFontSize(), so FontDocScale * zoom lands the InputText at the same size; the metrics
        // below are then in those same pixels. Transitions edit just a number, so scale that box
        // up a bit more — easier to read and hit — and the caption scales with it.
        float editScale = FontDocScale * _zoom * (_editKind == EditKind.TransitionFrames ? 1.6f : 1f);
        IG.SetWindowFontScale(editScale);

        var pad = IG.GetStyle().FramePadding;
        // Size the box to the current text (plus a little room for the caret) and centre it
        // on the anchor, so the left-aligned input sits where the centered label was. It
        // grows symmetrically as you type, staying centred.
        float caretSlack = IG.CalcTextSize("0").X + 4f;
        float textW = IG.CalcTextSize(_editBuffer.Length > 0 ? _editBuffer : " ").X;
        float boxW = textW + pad.X * 2f + caretSlack;
        // Keep a comfortable minimum so a single digit doesn't yield a cramped box.
        if (_editKind == EditKind.TransitionFrames)
            boxW = MathF.Max(boxW, IG.CalcTextSize("0000").X + pad.X * 2f);
        float boxH = IG.GetFrameHeight();
        var screen = anchor - new Vector2(boxW, boxH) * 0.5f;

        // For a transition, caption the field so it's clear you're editing the delay.
        // Centred just above the box, in the same zoomed font.
        if (_editKind == EditKind.TransitionFrames)
        {
            const string caption = "time";
            var capSize = IG.CalcTextSize(caption);
            IG.SetCursorScreenPos(new Vector2(anchor.X - capSize.X * 0.5f, screen.Y - capSize.Y - 2f));
            IG.PushStyleColor(ImGuiNET.ImGuiCol.Text, Col(0.70f, 0.78f, 0.85f));
            IG.TextUnformatted(caption);
            IG.PopStyleColor();
        }

        // Opaque field background — the default ImGui FrameBg is translucent, which let the
        // canvas/label bleed through the edit box.
        IG.PushStyleColor(ImGuiNET.ImGuiCol.FrameBg, Col(0.16f, 0.17f, 0.19f));
        IG.PushStyleColor(ImGuiNET.ImGuiCol.FrameBgHovered, Col(0.22f, 0.23f, 0.26f));
        IG.PushStyleColor(ImGuiNET.ImGuiCol.FrameBgActive, Col(0.24f, 0.25f, 0.28f));

        IG.SetCursorScreenPos(screen);
        IG.SetNextItemWidth(boxW);
        if (_focusEdit) { IG.SetKeyboardFocusHere(); _focusEdit = false; }

        var flags = ImGuiInputTextFlags.EnterReturnsTrue | ImGuiInputTextFlags.AutoSelectAll;
        if (_editKind == EditKind.TransitionFrames) flags |= ImGuiInputTextFlags.CharsDecimal;

        bool commit = IG.InputText("##automata-edit", ref _editBuffer, 128, flags);
        bool lostFocus = IG.IsItemDeactivated();

        IG.PopStyleColor(3);
        IG.SetWindowFontScale(1f);

        if (commit || lostFocus) CommitEdit();
    }

    private void CommitEdit()
    {
        if (_editKind == EditKind.StateLabel)
        {
            var s = StateById(_editStateOrTransitionId);
            if (s is not null) s.Label = _editBuffer.Trim();
        }
        else if (_editKind == EditKind.TransitionFrames)
        {
            var t = Document.Transitions.FirstOrDefault(x => TransitionKey(x) == _editStateOrTransitionId);
            if (t is not null && int.TryParse(_editBuffer, NumberStyles.Integer, CultureInfo.InvariantCulture, out var f))
                t.Frames = Math.Max(0, f);
        }
        else if (_editKind == EditKind.RegionTitle)
        {
            var r = Document.Regions.FirstOrDefault(x => x.Id == _editStateOrTransitionId);
            if (r is not null) r.Title = _editBuffer.Trim();
        }
        _editKind = EditKind.None;
        Changed?.Invoke();
    }

    public void Dispose() { }
}
