# Requires Xcode 16+, XcodeGen (brew install xcodegen) and Python 3 with Pillow (for the icon).
.PHONY: project icons test uitest server cli install-cli mac ios clean install

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

# BSD-54: the `based` command line. PREFIX defaults to ~/.local (no sudo); PREFIX=/usr/local for all users.
PREFIX ?= $(HOME)/.local
cli:
	cd Packages/BasedBrain && swift build -c release --product based

install-cli: cli
	mkdir -p $(PREFIX)/bin
	install -m 0755 "$$(cd Packages/BasedBrain && swift build -c release --show-bin-path)/based" $(PREFIX)/bin/based
	@echo "Installed $(PREFIX)/bin/based — next: based login --url <https://your-server>"

mac: project
	xcodebuild -project Based.xcodeproj -scheme Based-macOS -configuration Debug build

install:
	scripts/install-mac.sh

ios: project
	xcodebuild -project Based.xcodeproj -scheme Based-iOS -configuration Debug -destination 'generic/platform=iOS Simulator' build

clean:
	rm -rf Based.xcodeproj build
