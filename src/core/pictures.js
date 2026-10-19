// Picture tools follow the character the author opened, never an arbitrary library item.
import { editArtifactField, findArtifact } from './project.js';

/** One explicit avatar; retain both choices in the gallery, including older imported portraits. */
export function selectCharacterAvatar(project, projectId, characterId, mediaId) {
    const character = pictureTarget(project, projectId, characterId);
    const media = findArtifact(project, 'media', mediaId);
    if (!media) throw new Error('That picture is no longer available. Choose another saved picture.');
    if (media.kind !== 'image') throw new Error('Choose an image for the avatar.');
    if (character.avatarMediaId === mediaId) return project;
    const previous = findArtifact(project, 'media', character.avatarMediaId);
    const links = [...new Set([...(character.links?.media ?? []), ...(previous ? [previous.id] : []), mediaId])];
    let next = editArtifactField(project, 'characters', characterId, 'links.media', links, { summary: 'Kept avatar choices in gallery' });
    return editArtifactField(next, 'characters', characterId, 'avatarMediaId', mediaId, { summary: 'Chose avatar image' });
}

export function workingCharacter(project) {
    const id = project.workspace?.characterId;
    if (id) return project.characters.find(c => c.id === id) ?? null;
    return project.characters.length === 1 ? project.characters[0] : null;
}

export function pictureDraft(character) {
    return { purpose: 'avatar', prompt: '', negative: '', reference: true,
        ...(character.imagePrompts?.find(p => /avatar|portrait/i.test(p.purpose)) ?? {}),
        ...character.pictureDraft };
}

export function pictureTarget(project, projectId, characterId) {
    if (project.id !== projectId) throw new Error('The project changed. Return to the original project and try again.');
    const character = project.characters.find(c => c.id === characterId);
    if (!character) throw new Error('This character was removed. The picture was not attached to another character.');
    return character;
}
