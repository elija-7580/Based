import Foundation

/// Minimal streaming ZIP writer (PKZIP 2.0, entries stored uncompressed, UTF-8 names) for the workspace
/// archive (BSD-67). Images and videos are already compressed, so storing costs little and keeps the writer
/// tiny and platform-independent; `ZipArchive` reads the result. Up to 4 GB and 65 535 entries (no ZIP64).
public final class ZipWriter {
    private let handle: FileHandle
    private var offset: UInt64 = 0
    private var central: [UInt8] = []
    private var count = 0
    private var finished = false
    private let dosTime: UInt16
    private let dosDate: UInt16

    /// Creates (or truncates) the file at `url`.
    public init(url: URL, date: Date = Date()) throws {
        guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
            throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: url.path])
        }
        handle = try FileHandle(forWritingTo: url)
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone.current
        let c = cal.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        let year: Int = max(1980, min(2107, c.year ?? 1980)) - 1980
        let month: Int = c.month ?? 1, day: Int = c.day ?? 1
        let hour: Int = c.hour ?? 0, minute: Int = c.minute ?? 0, second: Int = c.second ?? 0
        let datePart: Int = (year << 9) | (month << 5) | day
        let timePart: Int = (hour << 11) | (minute << 5) | (second / 2)
        dosDate = UInt16(truncatingIfNeeded: datePart)
        dosTime = UInt16(truncatingIfNeeded: timePart)
    }

    deinit { try? handle.close() }

    public func add(path: String, data: Data) throws {
        precondition(!finished, "ZipWriter already finished")
        let name = Array(path.utf8)
        guard name.count <= 0xFFFF else { throw ZipError.unsupported("file name too long (\(path))") }
        guard count < 0xFFFF else { throw ZipError.unsupported("more than 65 535 files") }
        guard UInt64(data.count) < 0xFFFF_FFFF, offset + UInt64(data.count) + UInt64(name.count) + 30 < 0xFFFF_FFFF else {
            throw ZipError.unsupported("archive larger than 4 GB")
        }
        let crc = CRC32.checksum([UInt8](data))
        let size = UInt32(data.count)
        var local: [UInt8] = []
        local.le32(0x0403_4B50); local.le16(20); local.le16(0x0800); local.le16(0)
        local.le16(dosTime); local.le16(dosDate)
        local.le32(crc); local.le32(size); local.le32(size)
        local.le16(UInt16(name.count)); local.le16(0)
        local += name

        central.le32(0x0201_4B50); central.le16(20); central.le16(20); central.le16(0x0800); central.le16(0)
        central.le16(dosTime); central.le16(dosDate)
        central.le32(crc); central.le32(size); central.le32(size)
        central.le16(UInt16(name.count)); central.le16(0); central.le16(0)
        central.le16(0); central.le16(0); central.le32(0)
        central.le32(UInt32(offset))
        central += name

        try handle.write(contentsOf: Data(local))
        try handle.write(contentsOf: data)
        offset += UInt64(local.count) + UInt64(data.count)
        count += 1
    }

    /// Writes the central directory and closes the file.
    public func finish() throws {
        guard !finished else { return }
        finished = true
        guard offset + UInt64(central.count) < 0xFFFF_FFFF else { throw ZipError.unsupported("archive larger than 4 GB") }
        var end: [UInt8] = []
        end.le32(0x0605_4B50); end.le16(0); end.le16(0)
        end.le16(UInt16(count)); end.le16(UInt16(count))
        end.le32(UInt32(central.count)); end.le32(UInt32(offset)); end.le16(0)
        try handle.write(contentsOf: Data(central))
        try handle.write(contentsOf: Data(end))
        try handle.close()
    }
}

private extension Array where Element == UInt8 {
    mutating func le16(_ v: UInt16) { append(UInt8(v & 0xFF)); append(UInt8(v >> 8)) }
    mutating func le32(_ v: UInt32) { for s in stride(from: 0, to: 32, by: 8) { append(UInt8((v >> UInt32(s)) & 0xFF)) } }
}
