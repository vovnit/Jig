import SwiftUI
import WidgetKit
import AppIntents

private let group = "group.dev.nitochkin.Jig"
private func root() -> URL? { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) }
private func catalog() -> [[String: String]] {
    guard let url = root()?.appendingPathComponent("catalog.json"), let data = try? Data(contentsOf: url) else { return [] }
    return (try? JSONSerialization.jsonObject(with: data) as? [[String: String]]) ?? []
}
struct JigChoice: AppEntity {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Jig widget")
    static let defaultQuery = JigChoices()
    var id: String
    var title: String
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(title)") }
}
struct JigChoices: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [JigChoice] { try await suggestedEntities().filter { identifiers.contains($0.id) } }
    func suggestedEntities() async throws -> [JigChoice] { catalog().compactMap { row in guard let id = row["id"] else { return nil }; return JigChoice(id: id, title: row["title"] ?? "Jig") } }
    func defaultResult() async -> JigChoice? { try? await suggestedEntities().first }
}
struct JigConfiguration: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Choose an app widget"
    @Parameter(title: "Widget") var selection: JigChoice?
}
struct JigEntry: TimelineEntry {
    let date: Date
    let light: String?
    let dark: String?
    let url: URL?
}
struct JigProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> JigEntry { JigEntry(date: .now, light: nil, dark: nil, url: nil) }
    func snapshot(for configuration: JigConfiguration, in context: Context) async -> JigEntry { entries(configuration, context).first ?? placeholder(in: context) }
    func timeline(for configuration: JigConfiguration, in context: Context) async -> Timeline<JigEntry> {
        let values = entries(configuration, context)
        return Timeline(entries: values.isEmpty ? [placeholder(in: context)] : values, policy: .after(Date().addingTimeInterval(1800)))
    }
    private func entries(_ config: JigConfiguration, _ context: Context) -> [JigEntry] {
        guard let id = config.selection?.id ?? catalog().first?["id"], let meta = catalog().first(where: { $0["id"] == id }), let root = root() else { return [] }
        let size = context.family == .systemLarge ? "large" : context.family == .systemMedium ? "medium" : "small"
        guard let data = try? Data(contentsOf: root.appendingPathComponent("\(id)-\(size).json")), let items = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        var url = URLComponents(); url.scheme = "jig"; url.host = "open"; url.queryItems = [URLQueryItem(name: "app", value: meta["app"]), URLQueryItem(name: "screen", value: meta["open"])]
        let values = items.map { JigEntry(date: Date(timeIntervalSince1970: ($0["date"] as? Double ?? 0) / 1000), light: $0["light"] as? String, dark: $0["dark"] as? String, url: url.url) }
        let latest = values.last(where: { $0.date <= .now })
        return (latest.map { [$0] } ?? []) + values.filter { $0.date > .now }
    }
}
struct JigWidgetView: View {
    let entry: JigEntry
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        Group {
            if let name = (scheme == .dark ? entry.dark : entry.light), let path = root()?.appendingPathComponent(name).path, let image = UIImage(contentsOfFile: path) {
                Image(uiImage: image).resizable().scaledToFit().accessibilityLabel("Jig app widget")
            } else { Text("Open Jig to set up an app widget.").padding() }
        }.containerBackground(.background, for: .widget).widgetURL(entry.url)
    }
}
@main
struct JigWidgets: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "JigWidgets", intent: JigConfiguration.self, provider: JigProvider()) { entry in JigWidgetView(entry: entry) }
            .configurationDisplayName("Jig apps").description("Choose a widget from one of your apps.")
            .supportedFamilies([.systemSmall, .systemMedium, .systemLarge]).contentMarginsDisabled()
    }
}
