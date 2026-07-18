import { Module } from "@nestjs/common";

// Modules to be implemented (step 3 of the build plan):
//   RoomsModule       CRUD, slug generation (nanoid 8), join + socket token issuance
//   QueueModule       add/reorder/remove; resolves YouTube metadata via Data API v3
//   MembersModule     roles, kick/ban
//   Content notes:    Drive items are added client side via Google Picker
//                     (drive.file scope); server stores fileId + metadata only.
@Module({ imports: [] })
export class AppModule {}
