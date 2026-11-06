# based-server — always-on workspace: sync + MCP + agent scheduler
FROM swift:6.0-jammy AS build
RUN apt-get update && apt-get install -y libsqlite3-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Packages ./Packages
RUN cd Packages/BasedBrain && swift build -c release --static-swift-stdlib

FROM ubuntu:jammy
RUN apt-get update && apt-get install -y libsqlite3-0 ca-certificates tzdata && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/Packages/BasedBrain/.build/release/based-server /usr/local/bin/based-server
VOLUME /data
ENV BASED_DB=/data/based.sqlite BASED_PORT=8787
EXPOSE 8787
ENTRYPOINT ["based-server"]
