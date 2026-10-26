// Uaithne's SuperDirt startup, sent to sclang as one chunk. Uaithne fills in the
// {{…}} values and reads the UAITHNE:… lines this posts.
(
var port = {{port}};
var samples = {{samples}};

Server.default = s = Server(\uaithne, NetAddr("127.0.0.1", {{server_port}}));
s.options.numBuffers = 1024 * 256;
s.options.memSize = 8192 * 32;
s.options.numWireBufs = 128;
s.options.maxNodes = 1024 * 32;
s.options.numOutputBusChannels = 2;
s.options.numInputBusChannels = 2;
s.latency = 0.3;

// Global volume in dB; -90 or below mutes.
~uaithneVolume = { |db|
	if(db <= -90) { s.volume.mute } { s.volume.unmute; s.volume.volume = db };
};

// Records the main output as 32-bit float WAV. The recorder runs at the end
// of the default group (after SuperDirt, before s.volume), so recordings
// don't follow Uaithne's volume slider or mute.
~uaithneRecord = { |path|
	s.recHeaderFormat = "wav";
	s.recSampleFormat = "float";
	s.record(path, 0, 2, s.defaultGroup);
};
~uaithneStopRecord = { s.stopRecording };

// Tidal's MIDI out: `s "midi"` plays on the output whose "device:port" name
// contains `name` (empty turns it off). Latency 0, since SuperDirt already
// schedules events ahead.
~uaithneMidi = { |name|
	var dest;
	if(name.isEmpty) {
		~dirt.soundLibrary.addMIDI(\midi, nil);
		"UAITHNE:midi off".postln;
	} {
		if(MIDIClient.initialized.not) { MIDIClient.init(0, 0, false) } { MIDIClient.list };
		dest = MIDIClient.destinations.detect { |e| (e.device ++ ":" ++ e.name).containsi(name) };
		if(dest.isNil) {
			("UAITHNE:midi none " ++ name).postln;
		} {
			~midiOut = MIDIOut(0);
			if(thisProcess.platform.name == \linux) { ~midiOut.connect(dest.uid) } { ~midiOut = MIDIOut(0, dest.uid) };
			~midiOut.latency = 0;
			~dirt.soundLibrary.addMIDI(\midi, ~midiOut);
			("UAITHNE:midi " ++ dest.device ++ ":" ++ dest.name).postln;
		};
	};
};

// Loads the workspace library from Uaithne's list ("name<TAB>path" lines, in
// sample-index order), replacing whatever was loaded before.
~uaithneLoadSamples = { |path|
	var names = List[], files = ();
	if(File.exists(path).not) {
		"UAITHNE:error can't read the sample list %".format(path).postln;
	} {
		File.readAllString(path).split($\n).do { |line|
			var tab = line.find("\t"), name;
			if(tab.notNil) {
				name = line.keep(tab).asSymbol;
				if(files[name].isNil) { files[name] = List[]; names.add(name) };
				files[name].add(line.drop(tab + 1));
			};
		};
		~dirt.soundLibrary.freeAllSoundFiles;
		names.do { |name| ~dirt.soundLibrary.loadSoundFilePaths(files[name], name) };
		"UAITHNE:samples % sounds loaded into SuperDirt".format(names.size).postln;
	};
};

// Peak output level over `seconds` (for Uaithne's self-test).
~uaithneMeter = { |seconds = 2|
	var peak = 0;
	OSCdef(\uaithneMeter, { |msg| peak = max(peak, max(msg[3], msg[5])) }, '/uaithne/meter');
	fork {
		var synth = { SendPeakRMS.kr(InFeedback.ar(0, 2), 20, 3, '/uaithne/meter') }.play(s, addAction: \addToTail);
		seconds.wait;
		synth.free;
		OSCdef(\uaithneMeter).free;
		"UAITHNE:meter %".format(peak).postln;
	};
};

if(\SuperDirt.asClass.isNil) {
	"UAITHNE:error SuperDirt isn't installed in SuperCollider".postln;
} {
	s.waitForBoot({
		~dirt = \SuperDirt.asClass.new(2, s);
		~dirt.fileExtensions = ["wav", "wave", "aif", "aiff", "aifc", "flac", "mp3", "ogg", "opus"];
		// Read only headers now; audio loads on first use.
		~dirt.doNotReadYet = true;
		~uaithneLoadSamples.(samples);
		s.sync;
		~dirt.start(port, 0 ! 12);
		if(NetAddr.langPort == port or: { thisProcess.openPorts.includes(port) }) {
			"UAITHNE:ready".postln;
		} {
			"UAITHNE:error SuperDirt couldn't listen on port %; is another SuperCollider using it?".format(port).postln;
		};
	}, onFailure: {
		"UAITHNE:error the SuperCollider server didn't boot".postln;
	});
};
)
