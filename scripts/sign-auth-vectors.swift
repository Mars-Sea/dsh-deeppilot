// Signs the canonical auth strings from tests/fixtures/auth-vectors.json with a
// fresh CryptoKit P-256 key. This is the production signing direction (the iOS
// app signs, the Host verifies), so the Host's verifier is exercised against
// the exact DER layout Apple's stack emits. Driven by gen-auth-vectors.mts:
//   stdin : {"cases":[{"name":..., "canonical":...}]}
//   stdout: {"publicKey":<x9.63 base64url>, "signatures":[{"name":..., "signature":<DER base64url>}]}
import CryptoKit
import Foundation

func b64url(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

struct Case: Decodable { let name: String; let canonical: String }
struct Input: Decodable { let cases: [Case] }

let input = try JSONDecoder().decode(Input.self, from: FileHandle.standardInput.readDataToEndOfFile())
let key = P256.Signing.PrivateKey()
let signatures = try input.cases.map { item -> [String: String] in
    let signature = try key.signature(for: Data(item.canonical.utf8)).derRepresentation
    return ["name": item.name, "signature": b64url(signature)]
}
let output: [String: Any] = [
    "publicKey": b64url(key.publicKey.x963Representation),
    "signatures": signatures,
]
let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
