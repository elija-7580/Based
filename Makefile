# Requires Xcode 16+, XcodeGen (brew install xcodegen) and Python 3 with Pillow (for the icon).
.PHONY: project icons test uitest server mac ios clean

project: icons
	xcodegen generate
	@echo "Open Based.xcodeproj"

icons:
	-python3 scripts/make_icons.py

test:
	cd Packages/BasedCore && swift test
	cd Packages/BasedBrain && swift test

uitest: project
	xcodebuild -project Based.xcodeproj -scheme Based-macOS -configuration Debug test -only-testing:Based-macOS-UITests

uitest-ios: project
	xcodebuild -project Based.xcodeproj -scheme Based-iOS -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 16' test -only-testing:Based-iOS-UITests

server:
	cd Packages/BasedBrain && swift build -c release --product based-server

mac: project
	xcodebuild -project Based.xcodeproj -scheme Based-macOS -configuration Debug build

ios: project
	xcodebuild -project Based.xcodeproj -scheme Based-iOS -configuration Debug -destination 'generic/platform=iOS Simulator' build

clean:
	rm -rf Based.xcodeproj build
