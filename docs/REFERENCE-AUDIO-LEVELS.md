# Référence vocale et zones rendues muettes

Depuis **v0.32.5**, rendre une sélection muette ou régler son volume à 0 % ne supprime plus la voix fournie au moteur de doublage.

1. Coupez le son de la zone à remplacer dans la timeline.
2. Dans **Doublage**, choisissez **Audio de la réplique actuelle** et la piste contenant la voix souhaitée.
3. Vous pouvez **écouter la référence** et générer un nouvel essai sans réactiver la zone dans le mix.

La référence conserve les transferts, remplacements et traitements audio enregistrés sur la piste. Elle ignore les volumes et silences de piste et de sélection, ainsi que les boutons M/S. Cela s'applique à Audio original, Voix, Musique, Effets et aux pistes audio ajoutées.

Les mêmes règles servent aux références du changement de timbre, aux guides d'intonation tirés d'une réplique, à la préparation de références de personnage et de bibliothèque vocale, à leur préécoute et aux analyses vocales. Les doublages par lot utilisent la même extraction que le doublage d'une seule réplique.

| Usage | Volume/muet de piste | Volume/muet de sélection | Transferts et remplacements audio |
|---|---|---|---|
| Référence vocale et analyse de la voix | Ignorés | Ignorés | Conservés |
| Écoute et export du mix | Appliqués | Appliqués | Conservés |
| Copie/déplacement, effets et séparation locale | Ignorés | Appliqués | Conservés |

Un déplacement qui a retiré l'audio d'une piste reste respecté : choisissez sa piste de destination pour utiliser cet audio comme référence. Cette correction ne réactive pas les zones dans le mix, ne modifie pas la vidéo source et ne remplace aucun essai existant.
