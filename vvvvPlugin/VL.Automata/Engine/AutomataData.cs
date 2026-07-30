using System.Text.Json;
using System.Text.Json.Serialization;

namespace VL.Automata.Engine;

// Data model mirrored 1:1 from the cables op's stored JSON (att_inc_editor.js
// snapshot writer): states {id,label,x,y}, transitions {id,from,to,frames},
// regions {id,x,y,radius,title}. This same JSON is the source of truth in the
// vvvv port, produced by the editor window and read by the node factory.

public sealed class StateData
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("label")] public string Label { get; set; } = "";
    [JsonPropertyName("x")] public double X { get; set; }
    [JsonPropertyName("y")] public double Y { get; set; }
}

public sealed class TransitionData
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("from")] public string From { get; set; } = "";
    [JsonPropertyName("to")] public string To { get; set; } = "";
    [JsonPropertyName("frames")] public int Frames { get; set; }
}

public sealed class RegionData
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("x")] public double X { get; set; }
    [JsonPropertyName("y")] public double Y { get; set; }
    [JsonPropertyName("radius")] public double Radius { get; set; }
    [JsonPropertyName("title")] public string Title { get; set; } = "";
}

public sealed class AutomataDocument
{
    [JsonPropertyName("states")] public List<StateData> States { get; set; } = new();
    [JsonPropertyName("transitions")] public List<TransitionData> Transitions { get; set; } = new();
    [JsonPropertyName("regions")] public List<RegionData> Regions { get; set; } = new();

    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        WriteIndented = false
    };

    // Tolerant parse: any malformed/empty input yields an empty document, matching
    // the cables engine's parseStoredData() try/catch fallback.
    public static AutomataDocument Parse(string? stored)
    {
        if (string.IsNullOrWhiteSpace(stored)) return new AutomataDocument();
        try
        {
            return JsonSerializer.Deserialize<AutomataDocument>(stored, Options) ?? new AutomataDocument();
        }
        catch (JsonException)
        {
            return new AutomataDocument();
        }
    }

    public string Serialize() => JsonSerializer.Serialize(this, Options);
}
