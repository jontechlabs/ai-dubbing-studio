# Plusieurs pistes de doublage

La v0.54.0 permet de placer plusieurs dialogues indépendants au même moment sur des pistes de doublage distinctes. Chaque dialogue conserve ses propres textes, références, essais et réglages d’édition. Les voix sont entendues ensemble pendant la lecture synchronisée et dans le mix final exporté en MKV.

1. Cliquez sur **Pistes de doublage** dans la barre de la timeline (icône audio).
2. Cliquez sur **Ajouter une piste de doublage**, puis donnez-lui un nom, par exemple le nom du personnage.
3. Dans **Affecter un dialogue**, choisissez la réplique et sa piste de destination. Répétez pour les autres voix. Il est aussi possible de faire un clic droit sur un bloc de doublage → **Déplacer vers…**, ou **Nouvelle piste et y déplacer ce dialogue**.
4. Placez et étirez les blocs sur leur piste. Deux dialogues placés sur des pistes différentes peuvent avoir exactement le même début et la même fin. Les protections contre une collision restent actives au sein d’une même piste.
5. Réglez le volume (0 à 300 %), le mode muet ou le solo de chaque piste directement dans la timeline ou dans le gestionnaire. Le **Mix Doublage (général)** reste le réglage final commun : il doit être activé pour entendre les voix avec la vidéo. Les sous-titres et la vidéo restent indépendants de cette affectation.

![Deux dialogues au même timestamp sur des pistes distinctes](screenshots/dubbing-lanes-fr.png)

Les dialogues déjà créés restent sur la première piste. Pour ajouter une autre réplique au même créneau, utilisez le bouton d’ajout de dialogue existant, saisissez ses timestamps, puis affectez-la à une autre piste. Les sous-doublages issus de la séparation de plusieurs locuteurs restent compatibles ; leur regroupement est conservé.

Supprimer une piste renvoie ses dialogues à la première piste, en conservant leurs essais, leurs WAV, leurs textes et leurs placements. Si cela crée une collision sur cette piste, elle redevient visible comme telle ; affectez les dialogues à une autre piste pour les entendre simultanément. La première piste ne peut pas être supprimée. Jusqu’à 32 pistes sont disponibles.

Les réglages et affectations sont conservés après redémarrage et peuvent être annulés avec l’historique d’édition. Le projet passe au **format 32** lorsque ces nouvelles pistes sont utilisées ; utilisez la v0.54.0 ou une version plus récente pour le rouvrir. L’harmonisation du timbre par lot garde l’affectation de chaque dialogue et ajoute de nouveaux essais sans écraser les précédents. Les fichiers audio et la vidéo source restent intacts.

Les tests couvrent les collisions entre pistes et au sein d’une même piste, la durée/position, les gains/muet/solo, la suppression avec réaffectation, la sauvegarde, le redémarrage réel via MCP, la somme de vrais WAV et un véritable export MKV dont les deux voix simultanées sont mesurées et dont la vidéo conserve la même empreinte décodée. La lecture utilise le même gain de piste sur le bus Web Audio ; aucun rendu vidéo intermédiaire n’est nécessaire.
