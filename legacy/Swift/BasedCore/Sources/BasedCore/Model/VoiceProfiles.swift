import Foundation

// Voice profiles for meeting notes (opt-in): once you name "Speaker 2" as "Anna", later meetings recognise
// Anna's voice and label her automatically.
//
// A voice is a speaker embedding (a vector from the diarization model; same person → similar direction).
// Each meeting keeps the centroid of every speaker cluster; naming a speaker folds that centroid into the
// named profile, and the next final pass matches new clusters against the profiles by cosine similarity.
//
// Privacy: voice embeddings are biometric data (GDPR Art. 9). They live only in this device's local
// database (`meta` table), never in workspace records, so they don't sync, export or reach a server.
// Nothing is stored unless the user turns the feature on; "Forget all voices" deletes everything.

public struct VoiceProfile: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    /// Unit-length mean of everything learned for this person.
    public var embedding: [Float]
    /// Seconds of speech the embedding is built from (the weight of later updates).
    public var weight: Double
    public var updatedAt: Date

    public init(id: String = UUID().uuidString, name: String, embedding: [Float], weight: Double, updatedAt: Date = Date()) {
        self.id = id; self.name = name; self.embedding = embedding; self.weight = weight; self.updatedAt = updatedAt
    }
}

/// One embedding the diarizer produced for a stretch of speech.
public struct VoiceSample: Sendable, Hashable {
    public var speaker: String
    public var embedding: [Float]
    /// Seconds of speech × the diarizer's quality score.
    public var weight: Double
    public init(speaker: String, embedding: [Float], weight: Double) { self.speaker = speaker; self.embedding = embedding; self.weight = weight }
}

public enum VoicePrint {
    /// Below this cosine similarity a cluster is "someone new". Embeddings of one person across recordings
    /// usually land well above 0.7; different people rarely exceed 0.5.
    public static let defaultThreshold: Float = 0.68

    public static func normalized(_ v: [Float]) -> [Float]? {
        let n = v.reduce(Float(0)) { $0 + $1 * $1 }.squareRoot()
        guard n > 1e-6, n.isFinite else { return nil }
        return v.map { $0 / n }
    }

    public static func cosine(_ a: [Float], _ b: [Float]) -> Float {
        guard a.count == b.count, !a.isEmpty, let x = normalized(a), let y = normalized(b) else { return -1 }
        return zip(x, y).reduce(Float(0)) { $0 + $1.0 * $1.1 }
    }

    /// Weighted mean direction of each speaker's samples.
    public static func centroids(_ samples: [VoiceSample]) -> [String: (embedding: [Float], weight: Double)] {
        var sums: [String: ([Float], Double)] = [:]
        for s in samples where s.weight > 0 {
            guard let u = normalized(s.embedding) else { continue }
            var (acc, w) = sums[s.speaker] ?? ([Float](repeating: 0, count: u.count), 0)
            guard acc.count == u.count else { continue }
            for i in acc.indices { acc[i] += u[i] * Float(s.weight) }
            sums[s.speaker] = (acc, w + s.weight)
        }
        return sums.compactMapValues { acc, w in normalized(acc).map { ($0, w) } }
    }

    /// One-to-one assignment of clusters to profiles, best pairs first; nothing below `threshold`.
    public static func match(_ clusters: [String: [Float]], profiles: [VoiceProfile],
                             threshold: Float = defaultThreshold) -> [String: VoiceProfile] {
        var pairs: [(cluster: String, profile: Int, score: Float)] = []
        for (c, e) in clusters {
            for (i, p) in profiles.enumerated() {
                let s = cosine(e, p.embedding)
                if s >= threshold { pairs.append((c, i, s)) }
            }
        }
        pairs.sort { $0.score != $1.score ? $0.score > $1.score : ($0.cluster, $0.profile) < ($1.cluster, $1.profile) }
        var out: [String: VoiceProfile] = [:]
        var used = Set<Int>()
        for p in pairs where out[p.cluster] == nil && !used.contains(p.profile) {
            out[p.cluster] = profiles[p.profile]
            used.insert(p.profile)
        }
        return out
    }

    /// Folds a new centroid into a profile (weighted running mean, re-normalised). Weight is capped so a voice
    /// can still drift (new microphone, a cold) instead of freezing after the first hours.
    public static func learn(_ profile: VoiceProfile, _ embedding: [Float], weight: Double, at date: Date = Date()) -> VoiceProfile {
        guard let u = normalized(embedding), u.count == profile.embedding.count else { return profile }
        let old = min(profile.weight, 1_800)
        var mixed = profile.embedding
        for i in mixed.indices { mixed[i] = mixed[i] * Float(old) + u[i] * Float(weight) }
        var p = profile
        p.embedding = normalized(mixed) ?? profile.embedding
        p.weight = profile.weight + weight
        p.updatedAt = date
        return p
    }
}

/// Device-local storage of voice profiles and of the speaker centroids of recent meetings (so naming a speaker
/// later can still teach the profile). Lives in the persistence `meta` table; never synced.
@MainActor
public final class VoiceProfileStore {
    public struct Book: Codable, Sendable, Equatable {
        public var profiles: [VoiceProfile] = []
        /// meeting id → speaker id → centroid
        public var clusters: [String: [String: Cluster]] = [:]
        /// Most recent meetings first (bounded).
        public var order: [String] = []
        public init() {}
    }
    public struct Cluster: Codable, Sendable, Equatable {
        public var embedding: [Float]
        public var weight: Double
        /// Profile it was matched to or taught (so renaming again updates the same person).
        public var profileID: String?
    }

    static let key = "meeting.voices.v1"
    static let keepMeetings = 50
    public let persistence: Persistence?
    public private(set) var book: Book

    public init(persistence: Persistence?) {
        self.persistence = persistence
        book = persistence?.meta(Self.key).flatMap { try? JSONDecoder().decode(Book.self, from: $0) } ?? Book()
    }

    public var profiles: [VoiceProfile] { book.profiles }

    private func save() { persistence?.setMeta(Self.key, try? JSONEncoder().encode(book)) }

    /// After a final pass: remember this meeting's clusters and return the ones recognised as known people.
    @discardableResult
    public func recognise(meeting: String, samples: [VoiceSample], threshold: Float = VoicePrint.defaultThreshold) -> [String: VoiceProfile] {
        let cs = VoicePrint.centroids(samples)
        guard !cs.isEmpty else { return [:] }
        let found = VoicePrint.match(cs.mapValues(\.embedding), profiles: book.profiles, threshold: threshold)
        book.clusters[meeting] = cs.reduce(into: [:]) { out, kv in
            out[kv.key] = Cluster(embedding: kv.value.embedding, weight: kv.value.weight, profileID: found[kv.key]?.id)
        }
        book.order.removeAll { $0 == meeting }
        book.order.insert(meeting, at: 0)
        for old in book.order.dropFirst(Self.keepMeetings) { book.clusters[old] = nil }
        book.order = Array(book.order.prefix(Self.keepMeetings))
        save()
        return found
    }

    /// The user named a speaker: teach (or create) that person's profile from the meeting's cluster.
    @discardableResult
    public func learn(meeting: String, speaker: String, name: String, at date: Date = Date()) -> VoiceProfile? {
        let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, var cluster = book.clusters[meeting]?[speaker] else { return nil }
        let same = { (p: VoiceProfile) in p.name.caseInsensitiveCompare(clean) == .orderedSame }
        // The person with that name is taught (the auto-match was right, or the user corrected it to someone
        // known). A name nobody has yet is a new person, even if the cluster had been matched to someone else:
        // a wrong match must never teach that other person's profile.
        let profile: VoiceProfile
        if let i = book.profiles.firstIndex(where: same) {
            profile = VoicePrint.learn(book.profiles[i], cluster.embedding, weight: cluster.weight, at: date)
            book.profiles[i] = profile
        } else {
            profile = VoiceProfile(name: clean, embedding: cluster.embedding, weight: cluster.weight, updatedAt: date)
            book.profiles.append(profile)
        }
        cluster.profileID = profile.id
        book.clusters[meeting]?[speaker] = cluster
        save()
        return profile
    }

    public func rename(_ id: String, to name: String) {
        guard let i = book.profiles.firstIndex(where: { $0.id == id }) else { return }
        book.profiles[i].name = name
        save()
    }

    public func forget(_ id: String) {
        book.profiles.removeAll { $0.id == id }
        for (m, cs) in book.clusters {
            book.clusters[m] = cs.mapValues { var c = $0; if c.profileID == id { c.profileID = nil }; return c }
        }
        save()
    }

    /// Turning the feature off deletes everything.
    public func forgetAll() {
        book = Book()
        persistence?.setMeta(Self.key, nil)
    }
}
