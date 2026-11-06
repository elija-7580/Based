import Foundation
public typealias OSStatus = Int32
public let errSecSuccess: OSStatus = 0, errSecItemNotFound: OSStatus = -25300, errSecDuplicateItem: OSStatus = -25299
public let kSecClass = "class" as CFString, kSecClassGenericPassword = "genp" as CFString, kSecAttrService = "svce" as CFString, kSecAttrAccount = "acct" as CFString, kSecValueData = "v_Data" as CFString, kSecReturnData = "r_Data" as CFString, kSecMatchLimit = "m_Limit" as CFString, kSecMatchLimitOne = "m_LimitOne" as CFString, kSecMatchLimitAll = "m_LimitAll" as CFString, kSecAttrAccessible = "pdmn" as CFString, kSecAttrAccessibleAfterFirstUnlock = "ck" as CFString, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly = "cku" as CFString, kSecAttrSynchronizable = "sync" as CFString, kSecReturnAttributes = "r_Attributes" as CFString, kSecAttrLabel = "labl" as CFString, kSecUseDataProtectionKeychain = "nleg" as CFString
public typealias CFString = NSString
public typealias CFDictionary = NSDictionary
public typealias CFTypeRef = AnyObject
public func SecItemAdd(_ attributes: CFDictionary, _ result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus { 0 }
public func SecItemCopyMatching(_ query: CFDictionary, _ result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus { 0 }
public func SecItemUpdate(_ query: CFDictionary, _ attributes: CFDictionary) -> OSStatus { 0 }
public func SecItemDelete(_ query: CFDictionary) -> OSStatus { 0 }
public func SecRandomCopyBytes(_ rnd: Any?, _ count: Int, _ bytes: UnsafeMutableRawPointer) -> Int32 { 0 }
public let kSecRandomDefault: Any? = nil
