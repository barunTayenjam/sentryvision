# PostgreSQL Database Dockerfile
FROM postgres:15-alpine AS builder

RUN apk add --no-cache build-base clang21 llvm21-dev git

WORKDIR /tmp
RUN git clone --branch v0.8.0 --depth 1 https://github.com/pgvector/pgvector.git \
 && cd pgvector \
 && make \
 && make install

# Final image
FROM postgres:15-alpine

ENV POSTGRES_DB=sentryvision
ENV POSTGRES_USER=sentryvision
ENV POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-changeme}

# Copy pgvector extension files from builder
COPY --from=builder /usr/local/lib/postgresql/vector.so /usr/local/lib/postgresql/vector.so
COPY --from=builder /usr/local/share/postgresql/extension/vector* /usr/local/share/postgresql/extension/

EXPOSE 5432

# The default postgres entrypoint will handle database initialization