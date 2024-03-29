FROM node:18.18.0-alpine

WORKDIR /app

# Listening port
ARG PORT=3000
EXPOSE ${PORT}

ARG HOST
ARG APP_KEYS
ARG API_TOKEN_SALT
ARG ADMIN_JWT_SECRET
ARG TRANSFER_TOKEN_SALT 
ARG JWT_SECRET
ARG DATABASE_CLIENT
ARG DATABASE_HOST
ARG DATABASE_NAME
ARG DATABASE_USERNAME
ARG DATABASE_PASSWORD
ARG DATABASE_SSL

ENV NODE_ENV=production

COPY . .

RUN yarn install
RUN yarn build

CMD ["yarn", "start"]
