import { Module } from "@nestjs/common";

// Modules to be implemented (step 2 of the build plan):
//   EmailAuthModule    register, login, verify (argon2id + JWT RS256)
//   GoogleAuthModule   id_token verification via google-auth-library
//   AppleAuthModule    id_token verification (after Apple enrollment)
//   TokensModule       refresh rotation, revocation
//   GuestModule        room scoped guest tokens
@Module({ imports: [] })
export class AppModule {}
