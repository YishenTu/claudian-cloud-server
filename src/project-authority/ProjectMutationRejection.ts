import { CollabError } from '@claudian-collab/protocol';

/** The owning authority has proved that this exact mutation can never apply. */
export class ProjectMutationRejection extends CollabError {
  constructor(options: ConstructorParameters<typeof CollabError>[0]) {
    super(options);
    this.name = 'ProjectMutationRejection';
  }
}
