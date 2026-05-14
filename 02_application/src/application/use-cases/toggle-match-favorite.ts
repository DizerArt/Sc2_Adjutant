import type { Match } from "../../domain/entities/match.js";
import type { MatchRepository } from "../../domain/repositories/match-repository.js";

export type ToggleMatchFavoriteRequest = {
  readonly matchId: string;
};

export type ToggleMatchFavoriteResponse = {
  readonly match: Match | null;
};

export class ToggleMatchFavorite {
  constructor(private readonly matchRepository: MatchRepository) {}

  async execute(request: ToggleMatchFavoriteRequest): Promise<ToggleMatchFavoriteResponse> {
    const match = await this.matchRepository.findById(request.matchId);
    if (!match) {
      return { match: null };
    }

    const updatedMatch: Match = {
      ...match,
      favorite: !match.favorite,
      updatedAt: new Date().toISOString()
    };

    await this.matchRepository.save(updatedMatch);

    return { match: updatedMatch };
  }
}
