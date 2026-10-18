// Picture tools follow the character the author opened, never an arbitrary library item.
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
