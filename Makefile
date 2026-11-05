# Requires Xcode 16+, XcodeGen (brew install xcodegen) and Python 3 with Pillow (for the icon).
.PHONY: project icons test mac ios clean

project: icons
	xcodegen generate
	@echo "Open Based.xcodeproj"

icons:
	-python3 scripts/make_icons.py

test:
	cd Packages/BasedCore && swift test

mac: project
	xcodebuild -project Based.xcodeproj -scheme Based-macOS -configuration Debug build

ios: project
	xcodebuild -project Based.xcodeproj -scheme Based-iOS -configuration Debug -destination 'generic/platform=iOS Simulator' build

clean:
	rm -rf Based.xcodeproj build
