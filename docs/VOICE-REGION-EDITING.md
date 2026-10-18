# Retoucher une partie du doublage

Disponible depuis **v0.14.0**, pour les essais de tous les moteurs vocaux. Aucun modèle supplémentaire ni calcul GPU n’est nécessaire : le traitement audio est local avec FFmpeg et Rubber Band.

![Sélection et étirement local d’un doublage](screenshots/voice-region-editor-fr.png)

*Interface React réelle avec audio de démonstration synthétique et commandes natives simulées. Les tests audio et MKV utilisent séparément le véritable traitement FFmpeg.*

## Ouvrir et sélectionner

1. Choisissez un essai comme doublage actif de la réplique.
2. **Double-cliquez son bloc sur la piste Doublage**, ou sélectionnez la réplique puis utilisez le bouton **ciseaux** dans la barre de la timeline.
3. Dans la forme d’onde qui s’ouvre au-dessus des pistes, cliquez pour placer un curseur, ou faites glisser pour sélectionner une zone. Les champs **Début / Fin de la sélection (ms)** permettent un réglage précis. Ces temps sont relatifs au début de la voix, pas à celui de la vidéo.
4. **Écouter la sélection** joue exactement cet intervalle. Avec un simple curseur, l’écoute se poursuit jusqu’à la fin du doublage. Fermer l’éditeur, démarrer la vidéo ou modifier l’audio interrompt cette écoute.

L’éditeur affiche toute la voix sélectionnée, même si le bloc est petit dans la vue générale de la vidéo. Les [raccourcis de zoom](TIMELINE-ZOOM.md) restent disponibles pour examiner sa position dans la timeline.

## Actions

| Action | Résultat |
| --- | --- |
| **Insérer du silence** | Insère la valeur du champ **Durée (ms)** au curseur, ou au début de la sélection. Le son qui suit est décalé à l’intérieur de cet essai. |
| **Rendre muet** | Remplace l’audio sélectionné par du silence, en conservant sa durée et les sons suivants à leur place. |
| **Supprimer et rapprocher** | Retire la zone choisie et rapproche la suite de cet essai. Pour rendre toute la voix silencieuse, utilisez **Tout sélectionner → Rendre muet**. |
| **Volume de la zone → Appliquer le volume** | Fixe le volume de la sélection entre **0 et 200 %**. La valeur est absolue pour cette zone ; appliquer deux fois 150 % ne donne pas 225 %. Les volumes de piste et de monitoring s’appliquent ensuite. |
| **Tirer la poignée ↔** | Allonge ou réduit seulement la durée de la sélection, en conservant la hauteur de voix. Le son qui suit se déplace dans le même essai. **Échap** annule le geste avant son relâchement. |
| **Fixer la durée de la zone** | Applique précisément la valeur **Durée (ms)** à la zone sélectionnée, avec le même traitement de hauteur de voix. |
| **Restaurer l’audio original** | Retire les retouches locales de cet essai et revient au calage automatique de sa durée. Le déplacement du début de la voix est conservé. |

Pour augmenter un blanc existant, sélectionnez ce blanc puis tirez sa poignée ↔, ou définissez une nouvelle durée. Pour en créer un entre deux mots, placez un curseur entre les mots puis insérez du silence.

Les changements se sauvegardent automatiquement et s’annulent avec **Ctrl+Z**, puis se rétablissent avec **Ctrl+Maj+Z / Ctrl+Y**, lorsque le curseur n’édite pas un champ numérique. Chaque geste appliqué correspond à une opération d’annulation. Une augmentation de durée qui dépasserait le doublage suivant ou la fin de la vidéo est refusée : déplacez d’abord les autres blocs si vous souhaitez créer de la place.

## Conservation et écoute

- Le WAV généré reste intact. Les retouches sont enregistrées séparément **pour chaque essai** ; choisir un autre essai conserve les retouches du précédent.
- Les sous-titres, leurs traductions, leur validation et les autres répliques restent en place. Les automations de volume des pistes gardent leurs positions absolues dans la vidéo.
- Le lecteur vidéo, l’écoute de l’essai, l’export **WAV**, l’analyse des lèvres, la génération des retouches des lèvres et l’export **MKV** utilisent l’audio retouché. Le calage de la voix dans son créneau reste appliqué pour la lecture vidéo et le MKV.
- Une vidéo avec lèvres retouchées précédemment calculée pour cet essai est désactivée après une modification audio. Recalculez-la avant de la réactiver.
- Les rendus intermédiaires sont dans le cache du projet et sont recalculables. L’audio d’origine n’est jamais écrasé.

Les étirements extrêmes peuvent dégrader la diction ; réécoutez les jonctions et préférez une nouvelle génération si nécessaire. Limites : 120 secondes par voix retouchée et 256 segments internes. Une très petite sélection peut ne pas contenir assez de son pour produire un étirement utile.

Les projets existants restent lisibles. La première retouche locale utilise le **format de projet 11**, qui nécessite v0.14.0 ou plus récente. Conservez une copie du dossier si vous souhaitez le rouvrir avec une ancienne version.
