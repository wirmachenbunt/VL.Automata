using VL.Automata.Engine;

namespace VL.Automata;

// Splitter for the Automata node's one-cable `Automata` output (AutomataInfo): pulls the
// current state label and its frame counter back out. A zero-field [ProcessNode] — it holds
// no state, so it's a plain getter, but ProcessNode is how this project declares a named node
// in a chosen category (there's no stateless-node attribute in the SDK). Add sibling
// Get… nodes the same way if you want to unpack more of AutomataInfo onto separate cables.
[ProcessNode(Name = "GetActiveState", Category = "Automata")]
public class GetActiveStateNode
{
    // A null/unconnected input yields empty/0 rather than throwing.
    public void Update(AutomataInfo? automata, out string activeState, out int stateFrames)
    {
        activeState = automata?.ActiveState ?? "";
        stateFrames = automata?.StateFrames ?? 0;
    }
}
