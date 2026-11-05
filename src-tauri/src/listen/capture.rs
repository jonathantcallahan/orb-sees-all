//! macOS: hears everything playing except Demian itself, through a Core Audio tap (macOS 14.2 and
//! later). The tap is private (only Demian sees it) and doesn't mute anything. Its audio comes in
//! through a private aggregate device, as any input would, and goes straight to the analysis
//! thread; nothing is kept.
//!
//! macOS asks for the System Audio Recording permission the first time it starts. Without it the
//! tap still runs but hears only silence, so the orb just rests.

use std::ffi::{c_void, CStr};
use std::ptr::NonNull;
use std::sync::Mutex;

use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchRetained};
use objc2::rc::Retained;
use objc2::AllocAnyThread;
use objc2_core_audio::*;
use objc2_core_audio_types::{kAudioFormatFlagIsFloat, AudioBufferList, AudioStreamBasicDescription, AudioTimeStamp};
use objc2_core_foundation::CFDictionary;
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSObject, NSString, NSUUID};

const SYSTEM: AudioObjectID = kAudioObjectSystemObject as AudioObjectID;

fn address(selector: AudioObjectPropertySelector, scope: AudioObjectPropertyScope) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress { mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain }
}

/// Reads a fixed-size property of an audio object.
unsafe fn property<T: Copy>(object: AudioObjectID, selector: AudioObjectPropertySelector, scope: AudioObjectPropertyScope, qualifier: Option<&[u8]>) -> Result<T, String> {
    let addr = address(selector, scope);
    let mut value: T = std::mem::zeroed();
    let mut size = std::mem::size_of::<T>() as u32;
    let (qsize, qdata) = qualifier.map_or((0, std::ptr::null()), |q| (q.len() as u32, q.as_ptr() as *const c_void));
    let status = AudioObjectGetPropertyData(object, NonNull::from(&addr), qsize, qdata, NonNull::from(&mut size), NonNull::from(&mut value).cast());
    if status == 0 {
        Ok(value)
    } else {
        Err(format!("couldn't read audio property {selector:#x} ({status})"))
    }
}

/// Reads a CFString property (returned retained, so we own it).
unsafe fn string_property(object: AudioObjectID, selector: AudioObjectPropertySelector) -> Result<Retained<NSString>, String> {
    let raw: *mut NSString = property(object, selector, kAudioObjectPropertyScopeGlobal, None)?;
    Retained::from_raw(raw).ok_or_else(|| "audio property was empty".to_string())
}

/// The device sound is playing through now.
pub fn default_output() -> AudioObjectID {
    unsafe { property(SYSTEM, kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal, None).unwrap_or(0) }
}

fn key(k: &CStr) -> Retained<NSString> {
    NSString::from_str(k.to_str().unwrap_or_default())
}

fn dict(entries: Vec<(&CStr, Retained<NSObject>)>) -> Retained<NSDictionary<NSString, NSObject>> {
    let keys: Vec<Retained<NSString>> = entries.iter().map(|(k, _)| key(k)).collect();
    let key_refs: Vec<&NSString> = keys.iter().map(|k| &**k).collect();
    let values: Vec<Retained<NSObject>> = entries.into_iter().map(|(_, v)| v).collect();
    NSDictionary::from_retained_objects(&key_refs, &values)
}

fn object<T: objc2::Message>(value: Retained<T>) -> Retained<NSObject> {
    // Every Foundation object is an NSObject.
    unsafe { Retained::cast_unchecked(value) }
}

type IoBlock = RcBlock<dyn Fn(NonNull<AudioTimeStamp>, NonNull<AudioBufferList>, NonNull<AudioTimeStamp>, NonNull<AudioBufferList>, NonNull<AudioTimeStamp>)>;

/// A running tap. Dropping it stops listening and removes the tap and its device.
pub struct Capture {
    tap: AudioObjectID,
    aggregate: AudioObjectID,
    proc_id: AudioDeviceIOProcID,
    _block: IoBlock,
    _queue: DispatchRetained<DispatchQueue>,
    pub sample_rate: f32,
    /// The output device it was built for; when the default output changes, build another.
    pub output: AudioObjectID,
}

impl Capture {
    /// Taps all audio but Demian's own, handing mono samples to `consumer`'s other end.
    pub fn start() -> Result<(Capture, rtrb::Consumer<f32>), String> {
        unsafe {
            let pid = std::process::id() as i32;
            let me: AudioObjectID = property(SYSTEM, kAudioHardwarePropertyTranslatePIDToProcessObject, kAudioObjectPropertyScopeGlobal, Some(&pid.to_ne_bytes()))?;
            let excluded = NSArray::from_retained_slice(&[NSNumber::new_u32(me)]);
            let description = CATapDescription::initStereoGlobalTapButExcludeProcesses(CATapDescription::alloc(), &excluded);
            let uuid = NSUUID::new();
            description.setUUID(&uuid);
            description.setName(&NSString::from_str("Demian listening"));
            description.setPrivate(true);
            description.setMuteBehavior(CATapMuteBehavior::Unmuted);
            let mut tap: AudioObjectID = 0;
            let status = AudioHardwareCreateProcessTap(Some(&description), &mut tap);
            if status != 0 || tap == 0 {
                return Err(format!("couldn't create the audio tap ({status})"));
            }
            let mut built = Built { tap, aggregate: 0, proc_id: None };

            let format: AudioStreamBasicDescription = property(tap, kAudioTapPropertyFormat, kAudioObjectPropertyScopeGlobal, None)?;
            if format.mFormatFlags & kAudioFormatFlagIsFloat == 0 || format.mBitsPerChannel != 32 {
                return Err("the tap's audio isn't 32-bit float".into());
            }

            let output = default_output();
            let output_uid = string_property(output, kAudioDevicePropertyDeviceUID)?;
            let yes = || object(NSNumber::new_bool(true));
            let description = dict(vec![
                (kAudioAggregateDeviceNameKey, object(NSString::from_str("Demian listening"))),
                (kAudioAggregateDeviceUIDKey, object(NSUUID::new().UUIDString())),
                (kAudioAggregateDeviceMainSubDeviceKey, object(output_uid.clone())),
                (kAudioAggregateDeviceIsPrivateKey, yes()),
                (kAudioAggregateDeviceIsStackedKey, object(NSNumber::new_bool(false))),
                (kAudioAggregateDeviceTapAutoStartKey, yes()),
                (kAudioAggregateDeviceSubDeviceListKey, object(NSArray::from_retained_slice(&[dict(vec![(kAudioSubDeviceUIDKey, object(output_uid))])]))),
                (
                    kAudioAggregateDeviceTapListKey,
                    object(NSArray::from_retained_slice(&[dict(vec![(kAudioSubTapDriftCompensationKey, yes()), (kAudioSubTapUIDKey, object(uuid.UUIDString()))])])),
                ),
            ]);
            // NSDictionary and CFDictionary are the same object (toll-free bridged).
            let cf: &CFDictionary = &*(Retained::as_ptr(&description) as *const CFDictionary);
            let status = AudioHardwareCreateAggregateDevice(cf, NonNull::from(&mut built.aggregate));
            if status != 0 {
                return Err(format!("couldn't create the listening device ({status})"));
            }

            // A second of audio is plenty of room: the analysis thread drains it every few ms.
            let (producer, consumer) = rtrb::RingBuffer::<f32>::new(format.mSampleRate as usize);
            let producer = Mutex::new(producer);
            let block: IoBlock = RcBlock::new(move |_now: NonNull<AudioTimeStamp>, input: NonNull<AudioBufferList>, _: NonNull<AudioTimeStamp>, _: NonNull<AudioBufferList>, _: NonNull<AudioTimeStamp>| {
                let Ok(mut producer) = producer.try_lock() else { return };
                let list = input.as_ptr();
                let count = (*list).mNumberBuffers as usize;
                let buffers = std::slice::from_raw_parts((*list).mBuffers.as_ptr(), count);
                // Mono: interleaved channels averaged, and separate buffers (one per channel) summed.
                let Some(first) = buffers.first() else { return };
                let channels = first.mNumberChannels.max(1) as usize;
                let frames = first.mDataByteSize as usize / 4 / channels;
                let gain = 1.0 / (channels * count) as f32;
                let take = frames.min(producer.slots());
                let Ok(chunk) = producer.write_chunk_uninit(take) else { return };
                chunk.fill_from_iter((0..take).map(|i| {
                    let mut sum = 0.0f32;
                    for buffer in buffers {
                        if buffer.mData.is_null() {
                            continue;
                        }
                        let data = buffer.mData as *const f32;
                        let ch = buffer.mNumberChannels.max(1) as usize;
                        for c in 0..ch {
                            sum += *data.add(i * ch + c);
                        }
                    }
                    sum * gain
                }));
            });
            let queue = DispatchQueue::new("app.demian.listening", None);
            let status = AudioDeviceCreateIOProcIDWithBlock(NonNull::from(&mut built.proc_id), built.aggregate, Some(&queue), RcBlock::as_ptr(&block) as AudioDeviceIOBlock);
            if status != 0 {
                return Err(format!("couldn't read from the listening device ({status})"));
            }
            let status = AudioDeviceStart(built.aggregate, built.proc_id);
            if status != 0 {
                return Err(format!("couldn't start listening ({status})"));
            }
            let (tap, aggregate, proc_id) = built.keep();
            Ok((
                Capture { tap, aggregate, proc_id, _block: block, _queue: queue, sample_rate: format.mSampleRate as f32, output },
                consumer,
            ))
        }
    }
}

/// What's been built so far, torn down again if starting fails partway.
struct Built {
    tap: AudioObjectID,
    aggregate: AudioObjectID,
    proc_id: AudioDeviceIOProcID,
}

impl Built {
    fn keep(mut self) -> (AudioObjectID, AudioObjectID, AudioDeviceIOProcID) {
        let parts = (self.tap, self.aggregate, self.proc_id);
        (self.tap, self.aggregate, self.proc_id) = (0, 0, None);
        parts
    }
}

unsafe fn tear_down(tap: AudioObjectID, aggregate: AudioObjectID, proc_id: AudioDeviceIOProcID) {
    if aggregate != 0 {
        if proc_id.is_some() {
            AudioDeviceStop(aggregate, proc_id);
            AudioDeviceDestroyIOProcID(aggregate, proc_id);
        }
        AudioHardwareDestroyAggregateDevice(aggregate);
    }
    if tap != 0 {
        AudioHardwareDestroyProcessTap(tap);
    }
}

impl Drop for Built {
    fn drop(&mut self) {
        unsafe { tear_down(self.tap, self.aggregate, self.proc_id) }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        unsafe { tear_down(self.tap, self.aggregate, self.proc_id) }
    }
}

