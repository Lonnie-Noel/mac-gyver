import SwiftUI
import Photos

@main
struct PhotosExportBridgeApp: App {
    @StateObject private var model = BridgeModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            VStack(alignment: .leading, spacing: 20) {
                Text("사진 내보내기 연결").font(.title.bold())
                Text("Mac의 USB 자동화 요청으로 사진 정보를 읽고 편집 결과를 JPEG로 내보냅니다. Mac에서 파일을 검증한 요청에만 원본 복원을 수행합니다.")
                Text(model.status).accessibilityIdentifier("exportBridgeStatus")
                Button("사진 접근 권한 설정") {
                    Task { await model.requestAuthorization() }
                }.accessibilityIdentifier("exportBridgeAuthorize")
                Text("사진 접근을 허용한 뒤 Mac에서 실행하세요. 자동화가 이 화면과 사진 앱을 전환합니다.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            .padding(28)
            .task { await model.poll() }
            .onChange(of: scenePhase) { _, phase in model.isActive = phase == .active }
        }
    }
}

@MainActor
final class BridgeModel: ObservableObject {
    @Published var status = "사진 접근 권한을 확인하세요."
    var isActive = true
    private let worker = BridgeWorker()

    func requestAuthorization() async {
        let result = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        status = result == .authorized
            ? "사진 접근 허용됨. Mac 요청을 기다립니다."
            : "파일명 중복을 확인하려면 전체 사진 접근이 필요합니다. 설정에서 사진 권한을 확인하세요."
    }

    func poll() async {
        while !Task.isCancelled {
            if isActive, let update = await worker.processPendingRequest() { status = update }
            try? await Task.sleep(nanoseconds: 750_000_000)
        }
    }
}
