using VL.Automata.Engine;
using VL.Lib.Collections;

namespace VL.Automata;

// Splitter for the Automata node's `Automata` output (AutomataInfo): the names of the
// regions the current state is inside. Regions can overlap, so this is a spread — zero,
// one, or several names — built by keeping the RegionNames whose aligned RegionActive is 1.
// Sibling of GetActiveState/GetActiveTransition; same zero-field [ProcessNode] pattern.
[ProcessNode(Name = "GetActiveRegion", Category = "Automata")]
public class GetActiveRegionNode
{
    // A null/unconnected input yields an empty spread rather than throwing.
    public void Update(AutomataInfo? automata, out Spread<string> activeRegions)
    {
        if (automata is null)
        {
            activeRegions = Spread<string>.Empty;
            return;
        }

        activeRegions = automata.RegionNames
            .Zip(automata.RegionActive, (name, active) => (name, active))
            .Where(r => r.active > 0.5f)
            .Select(r => r.name)
            .ToSpread();
    }
}
