# Hermetic build of htlc-lock. The base image is pinned by digest, so the
# compiler, libc and cargo home are the same on any machine.
# reproducible/reproduce.sh assembles a minimal context (contracts and
# rust-toolchain.toml) and builds this.
FROM rust:1.96.0-slim-bookworm@sha256:4732ca96fd086cb9be682050c3f0176288eebaac2b80aa2bcefccfaf198e1950
RUN rustup target add riscv64imac-unknown-none-elf
WORKDIR /src
COPY rust-toolchain.toml ./rust-toolchain.toml
COPY contracts ./contracts
RUN cd contracts/htlc-lock \
 && cargo build --release --locked --target riscv64imac-unknown-none-elf \
 && cp target/riscv64imac-unknown-none-elf/release/htlc-lock /htlc-lock \
 && sha256sum /htlc-lock
